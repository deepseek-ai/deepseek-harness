import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  bindManagedProcess,
  childEnv,
  killGroup,
  OutputCollector,
  spawnSubprocess,
  taskkillProcessTree,
  validateSubprocessSpec,
} from '../src/spawn.ts'
import type { SubprocessHandle, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { waitWithAbort } from '../src/managed-owner.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

/**
 * Translate the suite's POSIX command strings into node one-liners on Windows,
 * where no bash exists; the translated commands keep the same observable
 * stdout/stderr/exit-code contract the bash originals pin on POSIX.
 * @param command - the bash `-c` command string used by the test.
 * @returns the argv to spawn.
 */
function shellArgv(command: string): string[] {
  if (process.platform !== 'win32') return ['bash', '-c', command]
  const node = (script: string): string[] => [process.execPath, '-e', script]
  switch (command) {
    case 'true': return node('')
    case 'echo hello': return node('console.log("hello")')
    case 'echo hi': return node('console.log("hi")')
    case 'echo oops >&2': return node('console.error("oops")')
    case 'echo err >&2': return node('console.error("err")')
    case 'echo out; echo err >&2': return node('console.log("out"); console.error("err")')
    case 'echo out; echo to-parent >&2': return node('console.log("out"); console.error("to-parent")')
    case 'echo to-parent; echo err >&2': return node('console.log("to-parent"); console.error("err")')
    case 'exit 42': return node('process.exit(42)')
    case 'exit 7': return node('process.exit(7)')
    case 'pwd': return node('console.log(process.cwd())')
    case 'sleep 60': return node('setTimeout(() => {}, 60000)')
    case 'cat': return node('process.stdin.pipe(process.stdout)')
    case 'unused': return node('')
    case 'echo "${TERM:-unset}"': return node('console.log(process.env.TERM ?? "unset")')
    case 'echo "$EXTRA_ONE/$EXTRA_TWO"': return node('console.log(process.env.EXTRA_ONE + "/" + process.env.EXTRA_TWO)')
    case 'echo "$EXPLICIT_OVERRIDE_PASSWORD"': return node('console.log(process.env.EXPLICIT_OVERRIDE_PASSWORD)')
    case 'echo "${SUBPROCESS_TOMBSTONE_PROBE:-absent}"': return node('console.log(process.env.SUBPROCESS_TOMBSTONE_PROBE ?? "absent")')
    case 'echo "[${DSH_STALE:-absent}|$DSH_SHELL|$DSH_SESSION_ID]"':
      return node('console.log("[" + [process.env.DSH_STALE ?? "absent", process.env.DSH_SHELL, process.env.DSH_SESSION_ID].join("|") + "]")')
    case 'echo "[${DSH_TEST_API_KEY:-absent}|${DSH_TEST_TOKEN:-absent}|${SUBPROCESS_TEST_PASSWORD:-absent}|${DSH_TEST_PLAIN:-absent}]"':
      return node('console.log("[" + [process.env.DSH_TEST_API_KEY ?? "absent", process.env.DSH_TEST_TOKEN ?? "absent", process.env.SUBPROCESS_TEST_PASSWORD ?? "absent", process.env.DSH_TEST_PLAIN ?? "absent"].join("|") + "]")')
    case 'printf "%.0sx" $(seq 1 500)': return node('process.stdout.write("x".repeat(500))')
    case 'printf "%.0sx" $(seq 1 500); printf "%.0se" $(seq 1 500) >&2':
      return node('process.stdout.write("x".repeat(500)); process.stderr.write("e".repeat(500))')
    case 'for i in $(seq 1 200); do printf "line-%04d\\n" $i; done':
      return node('for (let i = 1; i <= 200; i++) console.log("line-" + String(i).padStart(4, "0"))')
    default:
      throw new Error(`spawn.spec: no win32 node translation for ${JSON.stringify(command)}`)
  }
}

const { failNextClose, failNextUnlink } = vi.hoisted(() => ({
  failNextClose: { value: false },
  failNextUnlink: { value: false },
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    closeSync(fd: number): void {
      if (failNextClose.value) {
        failNextClose.value = false
        throw Object.assign(new Error('simulated EIO on close'), { code: 'EIO' })
      }
      actual.closeSync(fd)
    },
    unlinkSync(path: Parameters<typeof actual.unlinkSync>[0]): void {
      if (failNextUnlink.value) {
        failNextUnlink.value = false
        throw Object.assign(new Error('simulated EIO on unlink'), { code: 'EIO' })
      }
      actual.unlinkSync(path)
    },
  }
})

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-subprocess-spec-'))

/** The per-process default spill dir captured by the default-spill test. */
let defaultSpillDir: string | undefined

afterAll(() => {
  rmSync(spillDir, { recursive: true, force: true })
  if (defaultSpillDir !== undefined) rmSync(defaultSpillDir, { recursive: true, force: true })
})

type SpecOverrides = Partial<Parameters<typeof spawnSubprocess>[0]> & {
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
  maxSpillBytes?: number
  stdin?: string
}

function spec(command: string, overrides: SpecOverrides = {}) {
  const { stdoutMaxBytes = 64_000, stderrMaxBytes = 64_000, maxSpillBytes = 64 * 1024 * 1024, stdin, ...rest } = overrides
  return {
    argv: shellArgv(command),
    cwd: process.cwd(),
    stdio: {
      stdin: stdin !== undefined ? { data: stdin } : 'ignore' as const,
      stdout: { maxBytes: stdoutMaxBytes, spill: { maxBytes: maxSpillBytes } },
      stderr: { maxBytes: stderrMaxBytes, spill: { maxBytes: maxSpillBytes } },
    },
    graceMs: 3_000,
    ...rest,
  }
}

/** Poll until a pid no longer exists, or is only a zombie on Linux. */
async function waitGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (process.platform === 'linux') {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
        if (state === 'Z' || state === 'X') return
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`)
}

async function waitForStdout(running: SubprocessHandle, expected: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (running.collected.stdout!.readFrom(0).text.includes(expected)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`stdout did not include ${JSON.stringify(expected)} after ${timeoutMs}ms`)
}

/** Await settlement and project both collected streams like a batch outcome. */
async function finish(running: SubprocessHandle) {
  const outcome = await running.done
  const final = (reader: SubprocessOutputReader | undefined) => {
    const read = reader!.readFrom(0)
    return { text: read.text, truncated: read.lossy, ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {} }
  }
  return { ...outcome, stdout: final(running.collected.stdout), stderr: final(running.collected.stderr) }
}

async function waitForPidFile(path: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, 'utf8').trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch {
      // The child shell has not written the pid file yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid file ${path} was not written after ${timeoutMs}ms`)
}

describe('spawnSubprocess', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMER_DELAY_MS + 1])(
    'rejects an invalid grace before spawning: %s',
    (graceMs) => {
      expect(() => { validateSubprocessSpec(spec('true', { graceMs })) })
        .toThrow(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
    },
  )

  it('captures stdout on success', async () => {
    const result = await finish(spawnSubprocess(spec('echo hello')))
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stdout.text).toBe('hello\n')
    expect(result.stdout.truncated).toBe(false)
    expect(result.stderr.text).toBe('')
  })

  it('captures stderr separately', async () => {
    const result = await finish(spawnSubprocess(spec('echo oops >&2')))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('')
    expect(result.stderr.text).toBe('oops\n')
  })

  it('captures both streams', async () => {
    const result = await finish(spawnSubprocess(spec('echo out; echo err >&2')))
    expect(result.stdout.text).toBe('out\n')
    expect(result.stderr.text).toBe('err\n')
  })

  it('reports non-zero exit codes', async () => {
    const result = await finish(spawnSubprocess(spec('exit 42')))
    expect(result.exitCode).toBe(42)
    expect(result.signal).toBeNull()
  })

  it('passes the ambient TERM through untouched (terminal policy is the caller\'s)', async () => {
    const result = await finish(spawnSubprocess(spec('echo "${TERM:-unset}"', {
      env: { TERM: 'callers-choice' },
    })))
    expect(result.stdout.text).toBe('callers-choice\n')
  })

  it.skipIf(process.platform === 'win32')('runs in the requested cwd', async () => {
    const result = await finish(spawnSubprocess(spec('pwd', { cwd: '/tmp' })))
    expect(result.stdout.text.trim()).toMatch(/\/tmp$/)
  })

  it('kills the process group with SIGTERM when the signal fires', async () => {
    // spawnSubprocess owns no timer: it kills on abort. The bash executor drives the timeout
    // by firing this signal via a deadline (see executor.spec.ts); here we
    // assert the kill itself lands as SIGTERM.
    const controller = new AbortController()
    const start = Date.now()
    const running = spawnSubprocess(spec('sleep 60', { signal: controller.signal }))
    setTimeout(() => { controller.abort('deadline') }, 100)
    const result = await running.done
    expect(Date.now() - start).toBeLessThan(5_000)
    // Windows teardown terminates through taskkill, which reports no signal.
    expect(result.signal).toBe(process.platform === 'win32' ? null : 'SIGTERM')
    expect(result.exitCode).toBe(process.platform === 'win32' ? 1 : null)
  })

  it.skipIf(process.platform === 'win32')('terminate() escalates to SIGKILL when SIGTERM is trapped', async () => {
    const running = spawnSubprocess(spec('trap \'\' TERM; echo ready; while :; do sleep 60 & wait $!; done', { graceMs: 200 }))
    await waitForStdout(running, 'ready\n')
    running.terminate()
    const result = await running.done
    expect(result.signal).toBe('SIGKILL')
  })

  it('cancels escalation when the terminated group vanishes before collected pipes drain', async () => {
    const pidFile = join(spillDir, `escaped-pipe-holder-${Date.now()}.pid`)
    const graceMs = 160
    const childScript = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: ['ignore', 1, 2],
      })
      writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid))
      helper.unref()
      setInterval(() => {}, 1000)
    `
    const running = spawnSubprocess({
      ...spec('unused', { graceMs }),
      argv: [process.execPath, '-e', childScript],
    })
    const helper = await waitForPidFile(pidFile)
    const realKill: typeof process.kill = process.kill.bind(process)
    let rootPid: number | undefined
    let termAt = 0
    let forceSignals = 0
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (typeof target !== 'number' || target >= 0) return realKill(target, signal)
      rootPid ??= -target
      if (target !== -rootPid) return realKill(target, signal)
      if (signal === 'SIGTERM') {
        termAt = Date.now()
        return realKill(target, signal)
      }
      if (signal === 'SIGKILL') {
        forceSignals += 1
        return true
      }
      if (signal === 0 && termAt !== 0 && Date.now() - termAt < graceMs / 2) {
        throw Object.assign(new Error('simulated vanished process group'), { code: 'ESRCH' })
      }
      return true // Before TERM the original group is live; later its pgid is reused.
    })
    try {
      running.terminate()
      await running.done
      expect(forceSignals).toBe(0)
    } finally {
      killSpy.mockRestore()
      try {
        process.kill(helper, 'SIGKILL')
      } catch {
        // taskkill already took the helper down on Windows.
      }
      await waitGone(helper)
    }
  })

  it.skipIf(process.platform === 'win32')('terminates the whole process group (grandchildren die too)', async () => {
    // The subshell writes the sleep's pid then waits on it; terminating the
    // group must take the sleep down with bash.
    const pidFile = join(spillDir, `grandchild-${Date.now()}.pid`)
    const running = spawnSubprocess(spec(`sleep 60 & echo $! > ${pidFile}; wait`))
    const grandchild = await waitForPidFile(pidFile)
    expect(grandchild).toBeGreaterThan(0)

    running.terminate()
    const result = await running.done
    expect(result.signal).toBe('SIGTERM')
    await waitGone(grandchild)
  })

  it('aborts via AbortSignal mid-run', async () => {
    const controller = new AbortController()
    const running = spawnSubprocess(spec('sleep 60', { signal: controller.signal }))
    setTimeout(() => { controller.abort('user cancelled') }, 50)
    const result = await running.done
    expect(result.signal).toBe(process.platform === 'win32' ? null : 'SIGTERM')
  })

  it('throws a stable Error when already aborted before spawn', () => {
    for (const [reason, message] of [
      ['too late', 'aborted before spawn: too late'],
      [null, 'aborted before spawn: aborted'],
    ] as const) {
      const controller = new AbortController()
      controller.abort(reason)
      expect(() => { validateSubprocessSpec(spec('echo hi', { signal: controller.signal })) })
        .toThrow(new Error(message))
    }

    const controller = new AbortController()
    controller.abort({
      [Symbol.toPrimitive]() {
        throw new Error('reason formatting must not escape')
      },
    })
    expect(() => { validateSubprocessSpec(spec('echo hi', { signal: controller.signal })) })
      .toThrow(new Error('aborted before spawn: aborted'))
  })

  it('rejects with a spawn error for a nonexistent cwd', async () => {
    await expect(spawnSubprocess(spec('echo hi', { cwd: '/nonexistent-dir-dsh-test' })).done)
      .rejects.toThrow(/ENOENT/)
  })

  it('terminate() is idempotent (second call does not restart escalation)', async () => {
    const running = spawnSubprocess(spec('sleep 60'))
    running.terminate()
    running.terminate()
    const result = await running.done
    expect(result.signal).toBe(process.platform === 'win32' ? null : 'SIGTERM')
  })

  it.skipIf(process.platform === 'win32')('does not wait for a Linux group that has only zombie members', async () => {
    const pidFile = join(spillDir, `zombie-group-${Date.now()}.pid`)
    const running = spawnSubprocess(spec(`sleep 60 & echo $! > ${pidFile}; echo leader-done`, { graceMs: 100 }), {
      platform: 'linux',
      linuxProcessGroupHasLiveMembers: () => false,
    })
    const descendant = await waitForPidFile(pidFile)
    try {
      await running.done
      await expect(running.waitForExit()).resolves.toBe(true)
    } finally {
      // The confirmed-absent verdict is a permanent no-more-signals boundary,
      // so terminate() must stay inert here; reap the live survivor directly.
      process.kill(descendant, 'SIGKILL')
      await waitGone(descendant)
    }
  })

  it.skipIf(process.platform === 'win32')('bounds inherited-pipe draining after the shell exits', async () => {
    const pidFile = join(spillDir, `pipe-holder-${Date.now()}.pid`)
    const started = Date.now()
    const running = spawnSubprocess(spec(`sleep 60 & echo $! > ${pidFile}; echo shell-done`, { graceMs: 100 }))
    const descendant = await waitForPidFile(pidFile)
    try {
      const result = await finish(running)
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.text).toBe('shell-done\n')
    } finally {
      process.kill(descendant, 'SIGKILL')
      await waitGone(descendant)
    }
  })
})

describe('stdin and extra env (set by in-process plugins)', () => {
  it('writes stdin to the command and closes it', async () => {
    const result = await finish(spawnSubprocess(spec('cat', { stdin: 'hello from stdin\n' })))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('hello from stdin\n')
  })

  it('a command that reads stdin sees EOF when none is supplied', async () => {
    // No stdin → fd 0 is /dev/null, so `cat` reads EOF and exits 0 with no
    // output (it does NOT block).
    const result = await finish(spawnSubprocess(spec('cat')))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('')
  })

  it.skipIf(process.platform === 'win32')('gives fd 0 the exact pre-seam type: /dev/null when no stdin, a pipe when supplied', async () => {
    // With no bytes, fd 0 remains the pre-spawn `ignore` default (/dev/null, a character device).
    // Supplied bytes use Node's spawn pipe, which is an AF_UNIX socket rather than a FIFO.
    const none = await finish(spawnSubprocess(spec('test -c /dev/stdin && echo char || echo other')))
    expect(none.stdout.text).toBe('char\n')
    const piped = await finish(spawnSubprocess(spec('test -S /dev/stdin && echo socket || echo other', { stdin: 'x' })))
    expect(piped.stdout.text).toBe('socket\n')
  })

  it('merges ordinary extra env entries onto the scrubbed environment', async () => {
    const result = await finish(spawnSubprocess(spec('echo "$EXTRA_ONE/$EXTRA_TWO"', {
      env: { EXTRA_ONE: 'alpha', EXTRA_TWO: 'beta' },
    })))
    expect(result.stdout.text).toBe('alpha/beta\n')
  })

  it('lets an explicit tombstone remove an ordinary ambient env entry', async () => {
    process.env.SUBPROCESS_TOMBSTONE_PROBE = 'ambient-value'
    try {
      const result = await finish(spawnSubprocess(spec(
        'echo "${SUBPROCESS_TOMBSTONE_PROBE:-absent}"',
        { env: { SUBPROCESS_TOMBSTONE_PROBE: undefined } },
      )))
      expect(result.stdout.text).toBe('absent\n')
    } finally {
      delete process.env.SUBPROCESS_TOMBSTONE_PROBE
    }
  })

  it('an explicit extra env entry overrides the credential scrub', async () => {
    // EXPLICIT_OVERRIDE_PASSWORD matches the credential scrub pattern, yet an explicit
    // entry is still honored — the scrub only drops AMBIENT process.env creds.
    const result = await finish(spawnSubprocess(spec('echo "$EXPLICIT_OVERRIDE_PASSWORD"', {
      env: { EXPLICIT_OVERRIDE_PASSWORD: 'explicit-wins' },
    })))
    expect(result.stdout.text).toBe('explicit-wins\n')
  })

  it('does not crash or reject when the child ignores a large stdin (EPIPE)', async () => {
    // The child exits without reading, so closing a stdin pipe holding ~1 MiB triggers EPIPE.
    // The handler swallows that write error and `done` reports the child's real exit.
    const big = 'x'.repeat(1024 * 1024)
    const result = await finish(spawnSubprocess(spec('exit 7', { stdin: big })))
    expect(result.exitCode).toBe(7)
  })
})

describe('output truncation and spill', () => {
  it('applies stdout and stderr caps independently', async () => {
    const result = await finish(spawnSubprocess(
      spec('printf "%.0sx" $(seq 1 500); printf "%.0se" $(seq 1 500) >&2', {
        stdoutMaxBytes: 500,
        stderrMaxBytes: 100,
      }),
      { spillDir },
    ))
    expect(result.stdout.truncated).toBe(false)
    expect(result.stdout.text).toBe('x'.repeat(500))
    expect(result.stderr.truncated).toBe(true)
    expect(result.stderr.text.length).toBeLessThanOrEqual(100)
  })

  it('keeps the tail and spills the full stream to disk', async () => {
    // 200 numbered lines of ~10 bytes; cap at 500 bytes keeps a late tail.
    const result = await finish(spawnSubprocess(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { stdoutMaxBytes: 500, stderrMaxBytes: 500 }),
      { spillDir },
    ))
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text.length).toBeLessThanOrEqual(500)
    expect(result.stdout.text).toContain('line-0200')
    expect(result.stdout.text).not.toContain('line-0001')
    expect(result.stdout.spillPath).toBeDefined()
    const full = readFileSync(result.stdout.spillPath!, 'utf8')
    expect(full).toContain('line-0001')
    expect(full).toContain('line-0200')
  })

  it('does not truncate output exactly at the cap', async () => {
    const result = await finish(spawnSubprocess(
      spec('printf "%.0sx" $(seq 1 500)', { stdoutMaxBytes: 500, stderrMaxBytes: 500 }),
      { spillDir },
    ))
    expect(result.stdout.truncated).toBe(false)
    expect(result.stdout.text.length).toBe(500)
    expect(result.stdout.spillPath).toBeUndefined()
  })

  it('settles with the tail and no spill path when final spill close fails', async () => {
    failNextClose.value = true
    const result = await finish(spawnSubprocess(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { stdoutMaxBytes: 500, stderrMaxBytes: 500 }),
      { spillDir },
    ))
    expect(failNextClose.value).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text).toContain('line-0200')
    expect(result.stdout.spillPath).toBeUndefined()
  })
})

describe('OutputCollector', () => {
  it('keeps the tail of a single oversized chunk', () => {
    const collector = new OutputCollector(10, 100, 'test', spillDir)
    collector.push(Buffer.from('0123456789abcdef'))
    const out = collector.finalize()
    expect(out.text).toBe('6789abcdef')
    expect(out.truncated).toBe(true)
    expect(readFileSync(out.spillPath!, 'utf8')).toBe('0123456789abcdef')
  })

  it('retains a byte-exact tail across uneven chunk boundaries', () => {
    // A diagnostic tail must be exactly the LAST maxBytes regardless of
    // chunking; dropping only whole chunks would under-retain.
    const collector = new OutputCollector(10, undefined, 'exact-tail', spillDir)
    collector.push(Buffer.from('aaaa'))
    collector.push(Buffer.from('bbbbbb'))
    collector.push(Buffer.from('cc'))
    const out = collector.finalize()
    expect(out.text).toBe('aabbbbbbcc')
    expect(Buffer.byteLength(out.text)).toBe(10)
    expect(out.truncated).toBe(true)
  })

  it('readFrom returns increments and flags lossy reads', () => {
    const collector = new OutputCollector(10, 100, 'test', spillDir)
    collector.push(Buffer.from('aaaaa'))
    const first = collector.readFrom(0)
    expect(first.text).toBe('aaaaa')
    expect(first.lossy).toBe(false)
    expect(first.nextOffset).toBe(5)

    collector.push(Buffer.from('bbbbb'))
    const second = collector.readFrom(first.nextOffset)
    expect(second.text).toBe('bbbbb')
    expect(second.lossy).toBe(false)

    // Push enough to slide the window past the last offset.
    collector.push(Buffer.from('c'.repeat(20)))
    const third = collector.readFrom(second.nextOffset)
    expect(third.lossy).toBe(true)
    expect(third.text).toBe('c'.repeat(10))
    expect(third.spillPath).toBeDefined()
  })

  it('contains close failures and drops the spill path', () => {
    const collector = new OutputCollector(4, 100, 'closefail', spillDir)
    collector.push(Buffer.from('aaaa'))
    collector.push(Buffer.from('bbbb'))
    expect(collector.readFrom(0).spillPath).toBeDefined()

    failNextClose.value = true
    let out: ReturnType<typeof collector.finalize>
    expect(() => { out = collector.finalize() }).not.toThrow()

    expect(failNextClose.value).toBe(false)
    expect(out!.text).toBe('bbbb')
    expect(out!.truncated).toBe(true)
    expect(out!.spillPath).toBeUndefined()
  })

  it('discards a spill that exceeds its configured cap', () => {
    const collector = new OutputCollector(4, 8, 'bounded', spillDir)
    collector.push(Buffer.from('aaaa'))
    collector.push(Buffer.from('bbbb'))
    const spillPath = collector.readFrom(0).spillPath!
    expect(readFileSync(spillPath, 'utf8')).toBe('aaaabbbb')

    collector.push(Buffer.from('c'))
    collector.push(Buffer.from('dddd'))
    const out = collector.finalize()
    expect(out.text).toBe('dddd')
    expect(out.truncated).toBe(true)
    expect(out.spillPath).toBeUndefined()
    expect(() => readFileSync(spillPath)).toThrow()
  })

  it('does not create a spill when the first overflowing chunk exceeds the cap', () => {
    const collector = new OutputCollector(4, 4, 'no-spill', spillDir)
    collector.push(Buffer.from('abcdefgh'))
    const out = collector.finalize()
    expect(out.text).toBe('efgh')
    expect(out.truncated).toBe(true)
    expect(out.spillPath).toBeUndefined()
  })

  it('contains cleanup failures while disabling an oversize spill', () => {
    const collector = new OutputCollector(4, 8, 'cleanup-fail', spillDir)
    collector.push(Buffer.from('aaaa'))
    collector.push(Buffer.from('bbbb'))
    const spillPath = collector.readFrom(0).spillPath!

    failNextClose.value = true
    failNextUnlink.value = true
    expect(() => { collector.push(Buffer.from('c')) }).not.toThrow()
    expect(failNextClose.value).toBe(false)
    expect(failNextUnlink.value).toBe(false)
    expect(collector.finalize().spillPath).toBeUndefined()
    unlinkSync(spillPath)
  })
})

describe('killGroup', () => {
  it('ignores an unpublished pid', () => {
    expect(() => { killGroup(undefined, 'SIGTERM') }).not.toThrow()
  })

  it('swallows ESRCH for vanished groups', async () => {
    expect(() => { killGroup(2 ** 30, 'SIGTERM') }).not.toThrow()
  })

})

describe('stdio dispositions', () => {
  it("'pipe' exposes raw streams for caller-owned protocol decoding", async () => {
    const running = spawnSubprocess({
      ...spec('cat'),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 1000 } },
    })
    expect(running.stdin).toBeDefined()
    expect(running.stdout).toBeDefined()
    expect(running.stderr).toBeUndefined()
    expect(running.collected.stdout).toBeUndefined()
    expect(running.collected.stderr).toBeDefined()

    const echoed = new Promise<string>((resolve) => {
      let text = ''
      running.stdout!.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      running.stdout!.on('end', () => { resolve(text) })
    })
    running.stdin!.end('through the pipe\n')
    const outcome = await running.done
    expect(outcome.exitCode).toBe(0)
    expect(await echoed).toBe('through the pipe\n')
  })

  it('a collect mode without spill keeps only the in-memory tail (no file)', async () => {
    const running = spawnSubprocess({
      ...spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done'),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 100 }, stderr: { maxBytes: 100 } },
    }, { spillDir })
    await running.done
    const read = running.collected.stdout!.readFrom(0)
    expect(read.lossy).toBe(true)
    expect(read.text).toContain('line-0200')
    expect(read.spillPath).toBeUndefined()
  })
})

describe('windows tree semantics (injected platform)', () => {
  it('hides the child window without changing output, exit, stdio, or tree-root options', async () => {
    let options: Parameters<typeof nodeSpawn>[2]
    const result = await finish(spawnSubprocess(spec('echo hello'), {
      spillDir,
      platform: 'win32',
      spawn: (program, args, spawnOptions) => {
        options = spawnOptions
        return nodeSpawn(program, args, spawnOptions)
      },
    }))

    expect(options!).toMatchObject({
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      stdout: { text: 'hello\n', truncated: false },
      stderr: { text: '', truncated: false },
    })
  })

  it('host-exit termination routes through taskkill immediately', async () => {
    const killed: number[] = []
    const running = spawnSubprocess(spec('exec sleep 60', { graceMs: 60_000 }), {
      spillDir,
      platform: 'win32',
      taskkill: (pid) => {
        killed.push(pid)
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone — matches taskkill's tolerated not-found status.
        }
      },
    })
    running.terminateForHostExit()
    await running.done
    expect(killed).toHaveLength(1)
    expect(killed[0]).toBeGreaterThan(0)
  })

  it('terminate routes through taskkill by root pid', async () => {
    const killed: number[] = []
    const running = spawnSubprocess(spec('exec sleep 60', { graceMs: 100 }), {
      spillDir,
      platform: 'win32',
      taskkill: (pid) => {
        killed.push(pid)
        // Simulate the forced tree termination taskkill performs.
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone — matches taskkill's tolerated not-found status.
        }
      },
    })
    running.terminate()
    const outcome = await running.done
    expect(killed).toHaveLength(1)
    expect(killed[0]).toBeGreaterThan(0)
    expect(outcome.signal).toBe(process.platform === 'win32' ? null : 'SIGKILL')
  })

  it('waitForExit falls back to direct-child liveness where groups do not exist', async () => {
    const running = spawnSubprocess(spec('true'), { spillDir, platform: 'win32', taskkill: () => {} })
    await running.done
    await expect(running.waitForExit()).resolves.toBe(true)
  })
})

describe('waitForExit', () => {
  it.skipIf(process.platform === 'win32')('waits for the whole detached tree, not just the shell', async () => {
    const pidFile = join(spillDir, `tree-wait-${Date.now()}.pid`)
    const running = spawnSubprocess(spec(`sleep 60 & echo $! > ${pidFile}; wait`))
    const grandchild = await waitForPidFile(pidFile)
    running.terminate()
    await running.done
    await expect(running.waitForExit()).resolves.toBe(true)
    await expect(waitGone(grandchild, 100)).resolves.toBeUndefined()
  })

  it('an aborted wait reports false while the tree lives', async () => {
    const running = spawnSubprocess(spec('sleep 60'))
    const controller = new AbortController()
    controller.abort()
    await expect(running.waitForExit(controller.signal)).resolves.toBe(false)
    running.terminate()
    await running.done
  })
})

describe.skipIf(process.platform === 'win32')('synchronous host-exit termination', () => {
  it('force-kills the current process tree without waiting for the normal grace', async () => {
    const running = spawnSubprocess(spec('trap "" TERM; sleep 60', { graceMs: 60_000 }))
    running.terminateForHostExit()
    await expect(running.done).resolves.toMatchObject({ exitCode: null, signal: 'SIGKILL' })
    await expect(running.waitForExit()).resolves.toBe(true)

    const kill = vi.spyOn(process, 'kill')
    try {
      running.terminateForHostExit()
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })
})

describe.skipIf(process.platform === 'win32')('tree-survivor escalation (terminate and bounded waits reach helpers the leader left behind)', () => {
  it('terminate() SIGKILLs a TERM-trapping descendant after the direct child settles', async () => {
    // The leader spawns a TERM-trapping helper with all stdio detached from
    // the collected pipes, then exits: the helper holds the GROUP alive while
    // the direct child settles. The escalation must still reach it.
    const pidFile = join(spillDir, `survivor-${Date.now()}.pid`)
    const running = spawnSubprocess(spec(
      `bash -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 60' >/dev/null 2>&1 & disown; wait_placeholder=; exit 0`,
      { graceMs: 300 },
    ))
    const helper = await waitForPidFile(pidFile)
    await running.done // direct child settled; helper survives in the group
    expect(() => process.kill(helper, 0)).not.toThrow()

    running.terminate() // SIGTERM (trapped) → grace → SIGKILL the group
    await expect(running.waitForExit()).resolves.toBe(true)
    await waitGone(helper)
  })

  it('a bounded waitForExit reports false while a survivor lives, true after escalation', async () => {
    const pidFile = join(spillDir, `survivor-wait-${Date.now()}.pid`)
    const running = spawnSubprocess(spec(
      `bash -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 60' >/dev/null 2>&1 & disown; exit 0`,
      { graceMs: 200 },
    ))
    const helper = await waitForPidFile(pidFile)
    await running.done
    // A consumer-owned teardown tier bounds its wait and reads the verdict.
    const bound = new AbortController()
    const timer = setTimeout(() => { bound.abort() }, 100)
    await expect(running.waitForExit(bound.signal)).resolves.toBe(false)
    clearTimeout(timer)
    running.terminate()
    await expect(running.waitForExit()).resolves.toBe(true)
    await expect(waitGone(helper)).resolves.toBeUndefined()
  })

  it('service teardown awaits tree survivors, not just handle settlement', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as InstanceType<typeof LocalSubprocessRuntime>).internals = { spillDir }
    const pidFile = join(spillDir, `survivor-svc-${Date.now()}.pid`)
    const running = ctx.subprocess.spawn(spec(
      `bash -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 60' >/dev/null 2>&1 & disown; exit 0`,
      { graceMs: 200 },
    ))
    const helper = await waitForPidFile(pidFile)
    await running.done
    await fiber.dispose()
    // Teardown itself waited for the survivor to become quiescent.
    await expect(waitGone(helper)).resolves.toBeUndefined()
  })
})

describe('coverage seams', () => {
  it('preserves a non-Error managed direct rejection', async () => {
    const direct = Promise.withResolvers<{ exitCode: number; signal: null }>()
    const handle = bindManagedProcess(spec('true', {
      graceMs: 1,
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    }), {
      stdin: null,
      stdout: null,
      stderr: null,
      direct: direct.promise,
      owner: {
        signal: vi.fn(),
        waitForExit: async () => { throw new Error('range unavailable') },
        terminateForHostExit: vi.fn(),
      },
    })

    direct.reject(null)
    await expect(handle.done).rejects.toBeNull()
    await Promise.resolve()
  })

  it('contains a managed-owner cleanup failure after direct and range settlement', async () => {
    const direct = Promise.withResolvers<{ exitCode: number; signal: null }>()
    const stopped = Promise.withResolvers<undefined>()
    const cleanup = vi.fn(() => { throw new Error('protocol cleanup failed') })
    const handle = bindManagedProcess(spec('true', {
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    }), {
      stdin: null,
      stdout: null,
      stderr: null,
      direct: direct.promise,
      owner: {
        signal: vi.fn(),
        waitForExit: () => stopped.promise,
        terminateForHostExit: vi.fn(),
        cleanup,
      },
    })

    const waiting = handle.waitForExit()
    stopped.resolve(undefined)
    await expect(waiting).resolves.toBe(true)
    expect(cleanup).not.toHaveBeenCalled()
    direct.resolve({ exitCode: 0, signal: null })
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await vi.waitFor(() => { expect(cleanup).toHaveBeenCalledOnce() })
  })

  it('retries an early range read but cleans and retains a terminal range failure', async () => {
    const direct = Promise.withResolvers<{ exitCode: number; signal: null }>()
    const earlyFailure = new Error('temporary range read failure')
    const terminalFailure = new Error('scope ended before launch request consumption')
    const waitForExit = vi.fn()
      .mockRejectedValueOnce(earlyFailure)
      .mockRejectedValueOnce(terminalFailure)
    const cleanup = vi.fn()
    const handle = bindManagedProcess(spec('true', {
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    }), {
      stdin: null,
      stdout: null,
      stderr: null,
      direct: direct.promise,
      owner: {
        signal: vi.fn(),
        waitForExit,
        terminateForHostExit: vi.fn(),
        cleanup,
      },
    })

    await expect(handle.waitForExit()).rejects.toBe(earlyFailure)
    expect(cleanup).not.toHaveBeenCalled()

    direct.resolve({ exitCode: 0, signal: null })
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(handle.waitForExit()).rejects.toBe(terminalFailure)
    await vi.waitFor(() => { expect(cleanup).toHaveBeenCalledOnce() })

    await expect(handle.waitForExit()).rejects.toBe(terminalFailure)
    expect(waitForExit).toHaveBeenCalledTimes(2)
  })

  it('does not deliver a stale escalation after range exit wins the timer race', async () => {
    vi.useFakeTimers()
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    try {
      const direct = Promise.withResolvers<{ exitCode: number; signal: null }>()
      const stopped = Promise.withResolvers<undefined>()
      const signal = vi.fn()
      const handle = bindManagedProcess(spec('true', {
        graceMs: 10,
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
      }), {
        stdin: null,
        stdout: null,
        stderr: null,
        direct: direct.promise,
        owner: {
          signal,
          waitForExit: () => stopped.promise,
          terminateForHostExit: vi.fn(),
        },
      })

      handle.terminate()
      expect(signal).toHaveBeenCalledExactlyOnceWith('SIGTERM', expect.any(Error))
      stopped.resolve(undefined)
      await expect(handle.waitForExit()).resolves.toBe(true)
      await vi.advanceTimersByTimeAsync(10)
      expect(signal).toHaveBeenCalledTimes(1)

      direct.resolve({ exitCode: 0, signal: null })
      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    } finally {
      clearTimer.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not restart managed termination after the escalation timer fires', async () => {
    vi.useFakeTimers()
    try {
      const direct = Promise.withResolvers<{ exitCode: number; signal: null }>()
      const stopped = Promise.withResolvers<undefined>()
      const signal = vi.fn()
      const handle = bindManagedProcess(spec('true', {
        graceMs: 10,
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
      }), {
        stdin: null,
        stdout: null,
        stderr: null,
        direct: direct.promise,
        owner: {
          signal,
          waitForExit: () => stopped.promise,
          terminateForHostExit: vi.fn(),
        },
      })

      handle.terminate()
      await vi.advanceTimersByTimeAsync(10)
      handle.terminate()
      await vi.advanceTimersByTimeAsync(10)
      expect(signal).toHaveBeenCalledTimes(2)
      expect(signal).toHaveBeenNthCalledWith(1, 'SIGTERM', expect.any(Error))
      expect(signal).toHaveBeenNthCalledWith(2, 'SIGKILL', undefined)

      stopped.resolve(undefined)
      await expect(handle.waitForExit()).resolves.toBe(true)
      direct.resolve({ exitCode: 0, signal: null })
      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('contains a late wait rejection after an already-aborted observation', async () => {
    const pending = Promise.withResolvers<never>()
    await expect(waitWithAbort(pending.promise, AbortSignal.abort())).resolves.toBe(false)
    pending.reject(new Error('late observation failure'))
    await Promise.resolve()
  })

  it('hides the taskkill helper window', () => {
    const taskkill = vi.mocked(nodeSpawnSync)
    taskkill.mockReturnValueOnce({} as never)
    taskkillProcessTree(77)
    expect(taskkill).toHaveBeenLastCalledWith(
      'taskkill',
      ['/PID', '77', '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    )
  })

  it('taskkillProcessTree ignores unpublished or non-positive pids and contains a missing binary', () => {
    expect(() => { taskkillProcessTree(undefined) }).not.toThrow()
    expect(() => { taskkillProcessTree(-1) }).not.toThrow()
    expect(() => { taskkillProcessTree(0) }).not.toThrow()
    // On POSIX there is no taskkill; spawnSync reports the failure in its
    // result and the function stays silent — the same containment Windows
    // relies on for an already-absent tree.
    expect(() => { taskkillProcessTree(2 ** 30) }).not.toThrow()
  })

  it('covers the injected POSIX group paths on any host', async () => {
    // Windows has no POSIX groups, so the tree-liveness probe, group
    // signalling, and the SIGKILL escalation timer only run here through the
    // injected platform; the mock keeps the group alive through TERM and
    // terminates the direct child when the escalation tier delivers SIGKILL.
    const running = spawnSubprocess(spec('sleep 60', { graceMs: 100 }), {
      platform: 'linux',
      linuxProcessGroupHasLiveMembers: () => false,
    })
    const realKill = process.kill.bind(process)
    let rootPid: number | undefined
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (typeof target === 'number' && target < 0) {
        rootPid ??= -target
        if (signal === 0) return true
        if (signal === 'SIGKILL') realKill(-target, 'SIGKILL')
        return true
      }
      return realKill(target, signal)
    })
    try {
      running.terminate()
      await running.done
      await expect(running.waitForExit()).resolves.toBe(true)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('treats a vanished group probe as quiescent without signalling', async () => {
    const running = spawnSubprocess(spec('sleep 60'), { platform: 'linux' })
    const realKill = process.kill.bind(process)
    let rootPid: number | undefined
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (typeof target === 'number' && target < 0) {
        rootPid ??= -target
        throw Object.assign(new Error('simulated absent group'), { code: 'ESRCH' })
      }
      return realKill(target, signal)
    })
    try {
      running.terminate()
      await new Promise(resolve => setTimeout(resolve, 20))
      if (rootPid === undefined) throw new Error('fallback owner did not probe its private process group')
      realKill(rootPid, 'SIGKILL')
      await running.done
      await expect(running.waitForExit()).resolves.toBe(true)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('treats an EPERM group probe as still alive', async () => {
    const running = spawnSubprocess(spec('sleep 60'), { platform: 'linux' })
    const realKill = process.kill.bind(process)
    let rootPid: number | undefined
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (typeof target === 'number' && target < 0 && signal === 0) {
        rootPid ??= -target
        throw Object.assign(new Error('simulated permission denial'), { code: 'EPERM' })
      }
      return realKill(target, signal)
    })
    try {
      await expect(running.waitForExit(AbortSignal.timeout(20))).resolves.toBe(false)
    } finally {
      killSpy.mockRestore()
      if (rootPid === undefined) throw new Error('fallback owner did not probe its private process group')
      realKill(-rootPid, 'SIGKILL')
      await running.done
    }
  })

  it('childEnv keeps the POSIX spread on non-Windows hosts', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    try {
      expect(childEnv({ DSH_X: '1' }).DSH_X).toBe('1')
    } finally {
      platform.mockRestore()
    }
  })

  it('settles through the pipe-drain timer when a descendant holds a collected pipe', async () => {
    // The leader spawns a detached grandchild inheriting the collected stdout
    // pipe, then exits: `close` cannot settle while the grandchild holds the
    // pipe, so the bounded pipe-drain timer must settle the outcome.
    const pidFile = join(spillDir, `pipe-drain-${Date.now()}.pid`)
    const childScript = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: ['ignore', 1, 2],
      })
      writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid))
      helper.unref()
    `
    const running = spawnSubprocess({
      ...spec('unused', { graceMs: 100 }),
      argv: [process.execPath, '-e', childScript],
    })
    // The drain timer starts when the child's stdio closes, which can precede
    // the pid file becoming visible; measure from before that wait so the
    // lower bound cannot be eroded by the pid-file handoff.
    const started = Date.now()
    const helper = await waitForPidFile(pidFile)
    const outcome = await running.done
    expect(outcome.exitCode).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
    try {
      process.kill(helper, 'SIGKILL')
    } catch {
      // Already gone; the drain bound is the point under test.
    }
    await waitGone(helper)
  })

  it('a spawn-failed handle rejects done while waitForExit reports gone', async () => {
    const running = spawnSubprocess(spec('true', { cwd: '/nonexistent-dir-dsh-dispose-test' }))
    await expect(running.done).rejects.toThrow()
    await expect(running.waitForExit()).resolves.toBe(true)
  })

  it("an 'inherit' stdout with collected stderr wires only the requested collector", async () => {
    const running = spawnSubprocess({
      ...spec('echo to-parent; echo err >&2'),
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: { maxBytes: 1000 } },
    })
    const outcome = await running.done
    expect(outcome.exitCode).toBe(0)
    expect(running.stdout).toBeUndefined()
    expect(running.collected.stdout).toBeUndefined()
    expect(running.collected.stderr!.readFrom(0).text).toBe('err\n')
  })

  it("an 'inherit' stderr with collected stdout wires only the requested collector", async () => {
    const running = spawnSubprocess({
      ...spec('echo out; echo to-parent >&2'),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 }, stderr: 'inherit' },
    })
    const outcome = await running.done
    expect(outcome.exitCode).toBe(0)
    expect(running.stderr).toBeUndefined()
    expect(running.collected.stderr).toBeUndefined()
    expect(running.collected.stdout!.readFrom(0).text).toBe('out\n')
  })

  it('terminate() after the tree died delivers no termination signal', async () => {
    const running = spawnSubprocess(spec('true'))
    await running.done
    const spy = vi.spyOn(process, 'kill')
    try {
      running.terminate()
      const delivered = spy.mock.calls.filter(([, sig]) => sig !== 0)
      expect(delivered).toEqual([])
    } finally {
      spy.mockRestore()
    }
    await running.waitForExit()
  })

  it('host-exit finalization synchronously terminates until range absence is observed', async () => {
    const taskkill = vi.fn()
    const running = spawnSubprocess(spec('true'), { platform: 'win32', taskkill })
    await running.done
    running.terminateForHostExit()
    await expect(running.waitForExit()).resolves.toBe(true)
    expect(taskkill).toHaveBeenCalledOnce()
  })

  it('repeated terminate after exit never probes or signals a reused process group', async () => {
    const running = spawnSubprocess(spec('sleep 60'))
    running.terminate()
    await running.done
    await running.waitForExit()
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      running.terminate()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('waitForExit on a failed spawn reports exited immediately', async () => {
    const running = spawnSubprocess(spec('true', { cwd: '/nonexistent-dir-dsh-spawn-test' }))
    await expect(running.done).rejects.toThrow()
    await expect(running.waitForExit()).resolves.toBe(true)
  })

  it('a batch-stdin handle exposes no stdin surface', async () => {
    const running = spawnSubprocess(spec('cat', { stdin: 'batch\n' }))
    expect(running.stdin).toBeUndefined()
    await running.done
    expect(running.collected.stdout!.readFrom(0).text).toBe('batch\n')
  })
})

describe('coverage seams 2', () => {
  it('win32 treeAlive reports alive for a live child and gone after taskkill', async () => {
    let killedPid = 0
    const running = spawnSubprocess(spec('sleep 60'), {
      spillDir,
      platform: 'win32',
      taskkill: (pid) => {
        killedPid = pid
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      },
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(running.waitForExit(aborted.signal)).resolves.toBe(false) // alive branch
    running.terminate()
    await running.done
    expect(killedPid).toBeGreaterThan(0)
    await expect(running.waitForExit()).resolves.toBe(true)
  })

  it('an inert win32 taskkill leaves the tree alive for a bounded wait to report', async () => {
    // An inert taskkill simulates a tree that never reports exit: terminate()
    // delivers nothing, so a bounded consumer wait must come back false.
    let rootPid: number | undefined
    const running = spawnSubprocess(spec('sleep 60'), {
      spillDir,
      platform: 'win32',
      taskkill: (pid) => { rootPid = pid },
    })
    running.terminate()
    const bound = new AbortController()
    const timer = setTimeout(() => { bound.abort() }, 60)
    await expect(running.waitForExit(bound.signal)).resolves.toBe(false)
    clearTimeout(timer)
    // Real cleanup: the injected platform spawned without detachment, so the
    // child is a plain (group-less) POSIX process — kill it directly.
    if (rootPid === undefined) throw new Error('fallback owner did not call its private taskkill adapter')
    process.kill(rootPid, 'SIGKILL')
    await running.done
  })

  it("stderr: 'pipe' exposes the raw stream", async () => {
    const running = spawnSubprocess({
      ...spec('echo err >&2'),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 }, stderr: 'pipe' },
    })
    expect(running.stderr).toBeDefined()
    const text = new Promise<string>((resolve) => {
      let out = ''
      running.stderr!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
      running.stderr!.on('end', () => { resolve(out) })
    })
    await running.done
    expect(await text).toBe('err\n')
  })
})

describe('argv validation', () => {
  it('rejects an empty argv before spawning', () => {
    expect(() => { validateSubprocessSpec({ ...spec('true'), argv: [] }) }).toThrow(/non-empty program name/)
  })

  it('rejects an empty program name before spawning', () => {
    expect(() => { validateSubprocessSpec({ ...spec('true'), argv: [''] }) }).toThrow(/non-empty program name/)
  })

  it.skipIf(process.platform === 'win32')('spawns argv verbatim without shell interpretation', async () => {
    const result = await finish(spawnSubprocess({ ...spec('unused'), argv: ['printf', '%s', '$HOME'] }))
    expect(result.stdout.text).toBe('$HOME')
  })
})

describe('abort edge cases', () => {
  it('uses a stable fallback for a reason-less pre-aborted signal', () => {
    const bare = {
      aborted: true,
      reason: undefined,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal
    expect(() => { validateSubprocessSpec(spec('echo hi', { signal: bare })) })
      .toThrow(new Error('aborted before spawn: aborted'))
  })

  it.skipIf(process.platform === 'win32')('reports the terminating signal of an externally self-killed command', async () => {
    // spawnSubprocess reports the raw signal; whether it counts as timeout/cancel is the
    // executor's classification (a self-kill is neither) — see executor.spec.ts.
    const result = await finish(spawnSubprocess(spec('kill -TERM $$')))
    expect(result.signal).toBe('SIGTERM')
  })
})

describe('environment and spill-file hardening', () => {
  it('scrubs credential-shaped and ambient DSH env vars from child processes', async () => {
    process.env.DSH_TEST_API_KEY = 'super-secret'
    process.env.DSH_TEST_TOKEN = 'also-secret'
    process.env.SUBPROCESS_TEST_PASSWORD = 'password-secret'
    process.env.DSH_TEST_PLAIN = 'visible'
    try {
      const result = await finish(spawnSubprocess(spec(
        'echo "[${DSH_TEST_API_KEY:-absent}|${DSH_TEST_TOKEN:-absent}|${SUBPROCESS_TEST_PASSWORD:-absent}|${DSH_TEST_PLAIN:-absent}]"',
      )))
      expect(result.stdout.text.trim()).toBe('[absent|absent|absent|absent]')
    } finally {
      delete process.env.DSH_TEST_API_KEY
      delete process.env.DSH_TEST_TOKEN
      delete process.env.SUBPROCESS_TEST_PASSWORD
      delete process.env.DSH_TEST_PLAIN
    }
  })

  it('forwards explicit DSH_* env entries while scrubbing ambient ones', async () => {
    // Both facts through one explicit map: the ambient DSH_STALE is dropped by
    // the scrub, and the deliberately supplied current values merge after it.
    process.env.DSH_STALE = 'old-value'
    try {
      const result = await finish(spawnSubprocess(spec('echo "[${DSH_STALE:-absent}|$DSH_SHELL|$DSH_SESSION_ID]"', {
        env: { DSH_SHELL: '1', DSH_SESSION_ID: 'current-session' },
      })))
      expect(result.stdout.text.trim()).toBe('[absent|1|current-session]')
    } finally {
      delete process.env.DSH_STALE
    }
  })

  it.skipIf(process.platform === 'win32')('creates spill files with owner-only permissions and random names', async () => {
    const result = await finish(spawnSubprocess(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { stdoutMaxBytes: 500, stderrMaxBytes: 500 }),
      { spillDir },
    ))
    const path = result.stdout.spillPath!
    expect(path).toMatch(/dsh-subprocess-\d+-\d+-[0-9a-f]{12}-stdout\.log$/)
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('defaults spills into a private per-process directory', async () => {
    const result = await finish(spawnSubprocess(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { stdoutMaxBytes: 500, stderrMaxBytes: 500 }),
    ))
    const dir = dirname(result.stdout.spillPath!)
    defaultSpillDir = dir
    expect(dir).toMatch(/dsh-subprocess-/)
    const mode = statSync(dir).mode & 0o777
    expect(mode).toBe(0o700)
  })

  it('killGroup never throws, even for EPERM-style failures', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    try {
      expect(() => { killGroup(12345, 'SIGTERM') }).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })

  it('honors AbortSignal on background-style runs (no timeout)', async () => {
    const controller = new AbortController()
    const running = spawnSubprocess(spec('sleep 60', { signal: controller.signal }))
    setTimeout(() => { controller.abort() }, 50)
    const result = await running.done
    expect(result.signal).toBe(process.platform === 'win32' ? null : 'SIGTERM')
  })
})
