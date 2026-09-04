import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import * as acp from '../src/index.ts'
import { acpStopReason, acpContentText, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, disposeAcpChild, startAcpRun, toAcpPrompt, type AcpRunSpec } from '../src/run.ts'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { spawnSubprocess } from '@deepseek-ai/dsh-subprocess-local/src/spawn.ts'

/**
 * Keyless integration tests for the ACP subagent backend. Each spawns a REAL
 * subprocess — the scripted mock ACP server (tests/mock-acp-server.ts) — and
 * drives it through the REAL backend over real ACP JSON-RPC stdio, so the
 * connection setup, the client callbacks, the prompt round-trip, the stop-reason
 * mapping, cancellation, and quiescent disposal are all exercised end to end.
 * No model, no key.
 */

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))

/** A parent Agent stub. The ACP backend reads exactly one thing off it: the session header's cwd (the workspace its child inherits). */
const fakeParent = { id: 'parent', session: { header: { cwd: process.cwd() } } } as unknown as Agent

function request(text = 'p', signal = new AbortController().signal) {
  return { prompt: [{ type: 'text' as const, text }], parent: fakeParent, signal }
}

interface SetupEnv {
  /** Mock-server scripting env: MOCK_TEXT / MOCK_STOP / MOCK_HANG / MOCK_PERMISSION. */
  [key: string]: string
}

/**
 * Mount the ACP backend pointed at the mock server, scripted by `mockEnv`.
 * `permission` selects the backend's auto-answer policy.
 */
async function setup(mockEnv: SetupEnv = {}, permission: 'allow' | 'reject' = 'reject') {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(acp, {
    providerName: 'acp',
    command: process.execPath,
    args: [mockServer],
    permission,
    env: mockEnv,
  })
  return ctx
}

function text(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

function expectedFailure(fields: string): string {
  return `Subagent failure (provider: ACP; ${fields})`
}

function expectedPermission(policy: 'allow' | 'reject', requestKind: string, decision: 'allowed' | 'denied'): string {
  return `ACP unattended decision (policy: ${policy}; request: ${requestKind}; decision: ${decision})`
}

/**
 * Poll until `file` exists (the mock touches it once its prompt is in flight),
 * so a cancel test waits on a CONDITION rather than an arbitrary timeout — the
 * subprocess cold-start is variable, and a fixed sleep both flakes and
 * slows the suite. Fails loud if the child never signals readiness.
 */
async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`mock child never became ready (${file})`)
    await new Promise(r => setTimeout(r, 10))
  }
}

function rejectFinalExitWait(child: SubprocessHandle, message: string): SubprocessHandle {
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    collected: child.collected,
    done: child.done,
    terminate: () => { child.terminate() },
    waitForExit: (signal?: AbortSignal) => signal === undefined
      ? Promise.reject(new Error(message))
      : Promise.resolve(false),
  }
}

function rejectFinalExitWaitAfterExit(child: SubprocessHandle, message: string): SubprocessHandle {
  return {
    ...rejectFinalExitWait(child, message),
    waitForExit: (signal?: AbortSignal) => signal === undefined
      ? child.done.then(() => Promise.reject(new Error(message)))
      : Promise.resolve(false),
  }
}

function tapBoundedExitWait(child: SubprocessHandle, onWait: () => void): SubprocessHandle {
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    collected: child.collected,
    done: child.done,
    terminate: () => { child.terminate() },
    waitForExit: (signal?: AbortSignal) => {
      if (signal !== undefined) onWait()
      return child.waitForExit(signal)
    },
  }
}

function replaceProtocolStreams(
  child: SubprocessHandle,
  stdin: PassThrough,
  stdout: Readable,
): SubprocessHandle {
  if (child.stdin === undefined) throw new Error('expected piped child stdin')
  stdin.pipe(child.stdin)
  return {
    pid: child.pid,
    stdin,
    stdout,
    stderr: child.stderr,
    collected: child.collected,
    done: child.done,
    terminate: () => { child.terminate() },
    waitForExit: (signal?: AbortSignal) => child.waitForExit(signal),
  }
}

function closeProtocolImmediately(child: SubprocessHandle): SubprocessHandle {
  const stdout = new PassThrough()
  stdout.end()
  return replaceProtocolStreams(child, new PassThrough(), stdout)
}

function closeProtocolOnPrompt(child: SubprocessHandle, onClose: () => void = () => {}): SubprocessHandle {
  if (child.stdout === undefined) throw new Error('expected piped child stdout')
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  child.stdout.pipe(stdout)
  let requestText = ''
  let closed = false
  stdin.on('data', (chunk: Buffer) => {
    if (closed) return
    requestText += chunk.toString('utf8')
    if (!requestText.includes('"session/prompt"')) return
    closed = true
    child.stdout?.unpipe(stdout)
    stdout.end()
    onClose()
  })
  return replaceProtocolStreams(child, stdin, stdout)
}

function replaceProcessOutcome(child: SubprocessHandle, outcome: SubprocessOutcome): SubprocessHandle {
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    collected: child.collected,
    done: child.done.then(() => outcome),
    terminate: () => { child.terminate() },
    waitForExit: (signal?: AbortSignal) => child.waitForExit(signal),
  }
}

describe('acpStopReason', () => {
  it('maps each ACP stop reason to the harness vocabulary', () => {
    expect(acpStopReason('end_turn')).toBe('completed')
    expect(acpStopReason('max_tokens')).toBe('max-tokens')
    expect(acpStopReason('refusal')).toBe('refusal')
    expect(acpStopReason('cancelled')).toBe('aborted')
    expect(acpStopReason('max_turn_requests')).toBe('error')
  })

  it('treats an unknown terminal reason as an error', () => {
    expect(acpStopReason('something-new' as never)).toBe('error')
  })
})

describe('acpContentText / toAcpPrompt', () => {
  it('extracts text from a text content block, empty for non-text', () => {
    expect(acpContentText({ type: 'text', text: 'hi' })).toBe('hi')
    // A non-text ACP content block (e.g. an image) contributes no text.
    expect(acpContentText({ type: 'image', data: 'x', mimeType: 'image/png' })).toBe('')
  })

  it('keeps text prompt blocks and drops non-text ones', () => {
    expect(toAcpPrompt([{ type: 'text', text: 'a' }])).toEqual([{ type: 'text', text: 'a' }])
    // A non-text harness block (e.g. reasoning) is dropped from the ACP prompt.
    expect(toAcpPrompt([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'think' }]))
      .toEqual([{ type: 'text', text: 'a' }])
  })
})

describe('child env layering (through the subprocess seam)', () => {
  it('drops credential-shaped ambient vars but keeps the explicit extras', async () => {
    process.env.ACP_TEST_AMBIENT_SECRET_TOKEN = 'leak-me'
    try {
      // The spec.env layer merges after the seam's scrub, so the child's own
      // explicitly-forwarded key survives while ambient credentials do not.
      const running = spawnSubprocess({
        argv: [
          process.execPath,
          '--input-type=module',
          '--eval',
          'process.stdout.write(JSON.stringify([process.env.ACP_TEST_AMBIENT_SECRET_TOKEN ?? "absent", process.env.DEEPSEEK_API_KEY]))',
        ],
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 }, stderr: { maxBytes: 1000 } },
        graceMs: 1000,
        env: { DEEPSEEK_API_KEY: 'explicit' },
      })
      await running.done
      expect(running.collected.stdout!.readFrom(0).text).toBe('["absent","explicit"]')
    } finally {
      delete process.env.ACP_TEST_AMBIENT_SECRET_TOKEN
    }
  })

  it('forwards explicit DSH_* config entries to the child', async () => {
    // A deployment sets child-harness facts like DSH_PERMISSION_MODE in
    // config.env; the seam's scrub drops only the AMBIENT namesakes, so the
    // explicit entry merges after it and the child must see the value.
    const ctx = await setup({ MOCK_ECHO_ENV: 'DSH_ACP_TEST_FACT', DSH_ACP_TEST_FACT: 'managed' })
    const parent = { id: 'parent', session: { header: { cwd: process.cwd() } } } as unknown as Agent
    const run = await ctx.subagents.start('acp', {
      label: 'p', prompt: [{ type: 'text' as const, text: 'p' }], parent, signal: new AbortController().signal,
    })
    const result = await run.result
    await run.dispose()
    const text = result.output.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
    expect(text).toBe('managed')
    await ctx.fiber.dispose()
  })
})

describe('disposeAcpChild (the backend-owned teardown ladder over seam verbs)', () => {
  const node = (source: string, stdin: 'pipe' | 'ignore' = 'pipe') => spawnSubprocess({
    argv: [process.execPath, '--input-type=module', '--eval', source],
    cwd: process.cwd(),
    stdio: { stdin, stdout: { maxBytes: 1000 }, stderr: { maxBytes: 1000 } },
    graceMs: 200,
  })
  const expectHostTermination = (outcome: SubprocessOutcome, posixSignal: NodeJS.Signals): void => {
    if (process.platform === 'win32') {
      expect(outcome.signal).toBeNull()
      expect(outcome.exitCode).not.toBe(0)
    } else {
      expect(outcome.signal).toBe(posixSignal)
    }
  }

  it('tier 1: a cooperative child exits on stdin EOF without any signal', async () => {
    const child = node('process.stdin.resume(); process.stdin.on("end", () => process.exit(0))')
    await disposeAcpChild(child, 5_000)
    const outcome = await child.done
    expect(outcome.exitCode).toBe(0)
    expect(outcome.signal).toBeNull()
  })

  it('tier 2: an EOF-deaf child reaches the host terminate outcome', async () => {
    const child = node('setInterval(() => {}, 60_000)')
    await disposeAcpChild(child, 100)
    const outcome = await child.done
    expectHostTermination(outcome, 'SIGTERM')
  })

  it('tier 3: a TERM-trapping child reaches the host force-termination outcome', async () => {
    const child = node('process.on("SIGTERM", () => {}); process.stdout.write("armed\\n"); setInterval(() => {}, 60_000)', 'ignore')
    // Wait for the trap to arm so SIGTERM cannot race the default handler.
    while (!child.collected.stdout!.readFrom(0).text.includes('armed')) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await disposeAcpChild(child, 50)
    const outcome = await child.done
    expectHostTermination(outcome, 'SIGKILL')
  })

  it('observes a spawn-level rejection and returns without a process to reap', async () => {
    const child = spawnSubprocess({
      argv: [process.execPath, '--input-type=module', '--eval', ''],
      cwd: '/nonexistent-dir-dsh-acp-ladder-test',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 }, stderr: { maxBytes: 1000 } },
      graceMs: 200,
    })
    await expect(disposeAcpChild(child, 1_000)).resolves.toBeUndefined()
    await expect(child.done).rejects.toThrow()
  })
})

describe('cwd resolution', () => {
  it('falls back to the parent session cwd for the child process AND its ACP session', async () => {
    // realpath: on macOS `tmpdir()` sits behind a symlink (/var → /private/var),
    // and the child reports its REAL process.cwd() — compare canonical paths.
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), 'acp-parent-cwd-')))
    try {
      const ctx = await setup({ MOCK_ECHO_CWD: '1' })
      const parent = { id: 'parent', session: { header: { cwd: workdir } } } as unknown as Agent
      const run = await ctx.subagents.start('acp', { prompt: [{ type: 'text' as const, text: 'p' }], parent, signal: new AbortController().signal })
      const result = await run.result
      await run.dispose()
      // Line 1: where the child process actually ran; line 2: the workspace the
      // backend announced in `session/new`. Both must be the parent's workspace.
      expect(text(result.output)).toBe(`${workdir}\n${workdir}`)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('rejects before spawning when neither config.cwd nor the parent session provides one', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'acp-no-cwd-'))
    const sentinel = join(tmp, 'spawned')
    try {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      // A command that would create the sentinel if the child were ever spawned.
      await ctx.plugin(acp, { providerName: 'acp', command: 'touch', args: [sentinel], permission: 'reject', env: {} })
      const parent = { id: 'parent', session: { header: {} } } as unknown as Agent
      await expect(ctx.subagents.start('acp', { prompt: [{ type: 'text' as const, text: 'p' }], parent, signal: new AbortController().signal }))
        .rejects.toThrow(`subagent-acp: ${expectedFailure('stage: initialize; category: configuration')}`)
      // Resolution failed BEFORE the process boundary — nothing was launched.
      expect(existsSync(sentinel)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('prefers the configured cwd override to the parent session cwd', async () => {
    const configured = realpathSync(mkdtempSync(join(tmpdir(), 'acp-cfg-cwd-')))
    const parentDir = realpathSync(mkdtempSync(join(tmpdir(), 'acp-parent-cwd-')))
    try {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(acp, {
        providerName: 'acp',
        command: process.execPath,
        args: [mockServer],
        cwd: configured,
        permission: 'reject',
        env: { MOCK_ECHO_CWD: '1' },
      })
      const parent = { id: 'parent', session: { header: { cwd: parentDir } } } as unknown as Agent
      const run = await ctx.subagents.start('acp', { prompt: [{ type: 'text' as const, text: 'p' }], parent, signal: new AbortController().signal })
      const result = await run.result
      await run.dispose()
      expect(text(result.output)).toBe(`${configured}\n${configured}`)
    } finally {
      rmSync(configured, { recursive: true, force: true })
      rmSync(parentDir, { recursive: true, force: true })
    }
  })

  it('resolves a relative config cwd against the launch directory at load', async () => {
    // The child process AND its announced ACP session cwd must both get the
    // ABSOLUTE form — DSH's own ACP server rejects a relative session cwd, and
    // deferring resolution to spawn would hide the launch-dir dependency.
    const relative = 'packages/subagent/subagent-acp'
    const absolute = resolve(relative)
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(acp, {
      providerName: 'acp',
      command: process.execPath,
      args: [mockServer],
      cwd: relative,
      permission: 'reject',
      env: { MOCK_ECHO_CWD: '1' },
    })
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    await run.dispose()
    expect(text(result.output)).toBe(`${realpathSync(absolute)}\n${absolute}`)
  })

  it('rejects an empty config cwd at load', async () => {
    // `path.resolve('')` is the process cwd, so an empty string would silently
    // reintroduce the launch-directory fallback this resolution removed.
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(acp, {
      providerName: 'acp',
      command: 'true',
      args: [],
      cwd: '',
      permission: 'reject',
      env: {},
    })).rejects.toThrow('config cwd must not be empty')
    await ctx.fiber.dispose()
  })

  // Windows ACLs do not expose the POSIX directory search-bit state this fixture creates.
  it.skipIf(process.platform === 'win32')('rejects a config cwd directory without search permission at load', async () => {
    // statSync().isDirectory() is true for a mode-600 directory, but a
    // subprocess cwd needs SEARCH permission — spawn would fail EACCES.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-noexec-'))
    chmodSync(tmp, 0o600)
    try {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await expect(ctx.plugin(acp, {
        providerName: 'acp',
        command: 'true',
        args: [],
        cwd: tmp,
        permission: 'reject',
        env: {},
      })).rejects.toThrow('not an accessible directory')
      await ctx.fiber.dispose()
    } finally {
      chmodSync(tmp, 0o700)
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects a config cwd that is not an accessible directory at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(acp, {
      providerName: 'acp',
      command: 'true',
      args: [],
      cwd: '/nonexistent/acp-child-workspace',
      permission: 'reject',
      env: {},
    })).rejects.toThrow('not an accessible directory')
    await ctx.fiber.dispose()
  })

  it('rejects a parent session cwd that is not absolute', async () => {
    // SessionHeader documents cwd as absolute; a relative value here is a broken
    // header, and resolving it against the server process cwd would silently
    // re-introduce the launch-directory dependency this resolution removes.
    const ctx = await setup({})
    const parent = { id: 'parent', session: { header: { cwd: 'relative/workspace' } } } as unknown as Agent
    await expect(ctx.subagents.start('acp', { prompt: [{ type: 'text' as const, text: 'p' }], parent, signal: new AbortController().signal }))
      .rejects.toThrow(`subagent-acp: ${expectedFailure('stage: initialize; category: configuration')}`)
  })

  it('rejects a parent session cwd that names a FILE, not a directory', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'acp-file-cwd-'))
    const file = join(tmp, 'a-file')
    writeFileSync(file, 'x')
    try {
      const ctx = await setup({})
      const parent = { id: 'parent', session: { header: { cwd: file } } } as unknown as Agent
      await expect(ctx.subagents.start('acp', { prompt: [{ type: 'text' as const, text: 'p' }], parent, signal: new AbortController().signal }))
        .rejects.toThrow(`subagent-acp: ${expectedFailure('stage: initialize; category: configuration')}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects a parent session cwd that is not an accessible directory, before spawning', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'acp-bad-parent-cwd-'))
    const sentinel = join(tmp, 'spawned')
    try {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(acp, { providerName: 'acp', command: 'touch', args: [sentinel], permission: 'reject', env: {} })
      const parent = { id: 'parent', session: { header: { cwd: join(tmp, 'vanished') } } } as unknown as Agent
      await expect(ctx.subagents.start('acp', { prompt: [{ type: 'text' as const, text: 'p' }], parent, signal: new AbortController().signal }))
        .rejects.toThrow(`subagent-acp: ${expectedFailure('stage: initialize; category: configuration')}`)
      expect(existsSync(sentinel)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('dsh-subagent-acp', () => {
  it('drives child processes with parent-unique run ids and returns streamed output', async () => {
    const ctx = await setup({ MOCK_TEXT: 'hello from acp child', MOCK_STOP: 'end_turn', MOCK_SESSION_ID: 'acp-child-session' })
    const run = await ctx.subagents.start('acp', request('do X'))
    expect(run.id).not.toBe('acp-child-session')
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.diagnostic).toBeUndefined()
    expect(text(result.output)).toBe('hello from acp child')
    const disposal = run.dispose()
    expect(run.dispose()).toBe(disposal)
    await disposal

    const nextRun = await ctx.subagents.start('acp', request('do X again'))
    expect(nextRun.id).not.toBe(run.id)
    expect(nextRun.id).not.toBe('acp-child-session')
    await nextRun.result
    await nextRun.dispose()
  })

  it('maps a max_tokens stop reason', async () => {
    const ctx = await setup({ MOCK_TEXT: 'cut off', MOCK_STOP: 'max_tokens' })
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('max-tokens')
    expect(result.diagnostic).toBeUndefined()
    await run.dispose()
  })

  it('maps a refusal stop reason', async () => {
    const ctx = await setup({ MOCK_TEXT: '', MOCK_STOP: 'refusal' })
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('refusal')
    expect(result.diagnostic).toBeUndefined()
    await run.dispose()
  })

  it.each([
    ['max_tokens', 'max-tokens'],
    ['refusal', 'refusal'],
  ] as const)('adds a permission fact to %s without changing its stop reason', async (remote, stopReason) => {
    const ctx = await setup({
      MOCK_PERMISSION: '1',
      MOCK_PERMISSION_IGNORE_DECISION: '1',
      MOCK_TOOL_KIND: 'read',
      MOCK_STOP: remote,
    }, 'reject')
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe(stopReason)
    expect(result.diagnostic).toBe(expectedPermission('reject', 'read', 'denied'))
    await run.dispose()
  })

  it('keeps an ordinary remote cancelled stop diagnostic-free', async () => {
    const ctx = await setup({ MOCK_STOP: 'cancelled' })
    const run = await ctx.subagents.start('acp', request())
    await expect(run.result).resolves.toEqual({ output: [{ type: 'text', text: 'mock child answer' }], stopReason: 'aborted' })
    await run.dispose()
  })

  it('preserves max_turn_requests as an actionable remote limit', async () => {
    const ctx = await setup({ MOCK_TEXT: 'partial', MOCK_STOP: 'max_turn_requests' })
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result).toEqual({
      output: [{ type: 'text', text: 'partial' }],
      diagnostic: expectedFailure('stage: prompt; category: remote-limit; stop reason: max_turn_requests'),
      stopReason: 'error',
    })
    await run.dispose()
  })

  it('uses a fixed fallback for an unknown remote stop reason', async () => {
    const rawReason = 'private/path/SECRET_TOKEN'
    const ctx = await setup({ MOCK_TEXT: 'partial', MOCK_STOP: rawReason })
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe(
      expectedFailure('stage: prompt; category: unknown; stop reason: unknown'),
    )
    expect(result.diagnostic).not.toContain(rawReason)
    await run.dispose()
  })

  it('aborting the required signal cancels a running child', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'acp-cancel-'))
    const readyFile = join(tmp, 'ready')
    try {
      const ctx = await setup({ MOCK_TEXT: 'partial', MOCK_HANG: '1', MOCK_READY_FILE: readyFile })
      const controller = new AbortController()
      const run = await ctx.subagents.start('acp', request('p', controller.signal))
      // Wait until the child's prompt is in flight (condition, not a sleep),
      // then cancel — so we exercise the mid-run session/cancel path.
      await waitForFile(readyFile)
      controller.abort('test')
      const result = await run.result
      expect(result.stopReason).toBe('aborted')
      expect(result.diagnostic).toBeUndefined()
      await run.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects WITHOUT spawning the child when the signal is already aborted', async () => {
    // A pre-aborted request must not even launch the configured binary. Point
    // the command at one that would create a sentinel file if it ever ran, and
    // assert the sentinel never appears.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-preabort-'))
    const sentinel = join(tmp, 'spawned')
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(startAcpRun(
        request('p', controller.signal),
        // `touch <sentinel>` — runs only if the process is actually spawned.
        { command: 'touch', args: [sentinel], cwd: tmp, permission: 'reject', env: {}, disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS, disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS, spawn: spawnSubprocess },
      )).rejects.toThrow('aborted before the ACP child started')
      // The binary was never launched — no sentinel.
      expect(existsSync(sentinel)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects a pre-aborted request through the registered provider before cwd resolution', async () => {
    const ctx = await setup()
    const controller = new AbortController()
    controller.abort()
    const parent = { id: 'parent', session: { header: {} } } as unknown as Agent
    await expect(ctx.subagents.start('acp', {
      prompt: [{ type: 'text' as const, text: 'p' }],
      parent,
      signal: controller.signal,
    })).rejects.toThrow('subagent request was aborted before the ACP child started')
  })

  it('reports an initialize-stage process exit without copying the transport error', async () => {
    const error = await startAcpRun(request(), {
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      permission: 'reject',
      env: { MOCK_CRASH_ON_INITIALIZE: '1' },
      disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
      disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
      spawn: spawnSubprocess,
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      `subagent-acp: ${expectedFailure('stage: initialize; category: process-exit; exit code: 11')}`,
    )
  })

  it('reports initialize-stage transport when the child closes the protocol but stays alive', async () => {
    const error = await startAcpRun(request(), {
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      permission: 'reject',
      env: {},
      disposeEofGraceMs: 50,
      disposeGraceMs: 50,
      spawn: spec => closeProtocolImmediately(spawnSubprocess(spec)),
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      `subagent-acp: ${expectedFailure('stage: initialize; category: transport')}`,
    )
  })

  it('reaps a child whose session/new response omits the session id', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'acp-malformed-session-'))
    const flushed = join(tmp, 'flushed')
    let boundedWaits = 0
    try {
      await expect(startAcpRun(request(), {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        env: {
          MOCK_MISSING_SESSION_ID: '1',
          MOCK_FLUSH_ON_EOF: flushed,
          MOCK_FLUSH_DELAY_MS: '20',
        },
        disposeEofGraceMs: 1000,
        disposeGraceMs: 100,
        spawn: spec => tapBoundedExitWait(spawnSubprocess(spec), () => { boundedWaits += 1 }),
      })).rejects.toThrow(
        `subagent-acp: ${expectedFailure('stage: new-session; category: protocol')}`,
      )
      // Startup rejects only after its private child reaches quiescence. The
      // marker proves rollback closed stdin and allowed the child's EOF flush.
      expect(existsSync(flushed)).toBe(true)
      expect(boundedWaits).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('aggregates safe startup and teardown facts when rollback itself fails', async () => {
    const rawCleanup = 'rollback leaked /private/path SECRET_TOKEN'
    let realChild: SubprocessHandle | undefined
    const errors: string[] = []
    const error = await startAcpRun(request(), {
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      permission: 'reject',
      env: { MOCK_MISSING_SESSION_ID: '1' },
      disposeEofGraceMs: 10,
      disposeGraceMs: 10,
      spawn: (spec) => {
        realChild = spawnSubprocess(spec)
        return rejectFinalExitWaitAfterExit(realChild, rawCleanup)
      },
      onError: (failure) => { errors.push(failure.message) },
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as Error).message).toContain(
      `subagent-acp: ${expectedFailure('stage: new-session; category: protocol')}; `
      + 'subagent-acp: Subagent failure (provider: ACP; stage: teardown; category: process-exit;',
    )
    expect((error as Error).message).not.toContain(rawCleanup)
    expect(errors).toContain('ACP child published without a session id')
    expect(errors).toContain(rawCleanup)
    await realChild?.done
  })

  it('reports only the safe teardown failure when cancelled startup rollback fails', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'acp-cancelled-rollback-'))
    const ready = join(tmp, 'ready')
    const go = join(tmp, 'go')
    const rawCleanup = 'cancel rollback leaked SECRET_TOKEN'
    const errors: string[] = []
    let realChild: SubprocessHandle | undefined
    try {
      const controller = new AbortController()
      const starting = startAcpRun(request('p', controller.signal), {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        env: { MOCK_NEWSESSION_READY: ready, MOCK_NEWSESSION_GO: go },
        disposeEofGraceMs: 10,
        disposeGraceMs: 10,
        spawn: (spec) => {
          realChild = spawnSubprocess(spec)
          return rejectFinalExitWait(realChild, rawCleanup)
        },
        onError: (error) => { errors.push(error.message) },
      })
      await waitForFile(ready)
      controller.abort()
      writeFileSync(go, 'go')
      const error = await starting.catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toHaveLength(1)
      expect((error as Error).message).toBe(
        `subagent-acp: ${expectedFailure('stage: teardown; category: unknown')}`,
      )
      expect((error as Error).message).not.toContain(rawCleanup)
      expect(errors).toEqual([rawCleanup])
      await realChild?.done
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('dispose escalates SIGTERM → SIGKILL for a child that traps SIGTERM (bounded quiescence)', async () => {
    // The child traps SIGTERM and keeps its event loop alive, so a graceful
    // term alone would hang dispose forever. With a short grace, dispose must
    // escalate to SIGKILL and return once the process is actually gone.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-trap-'))
    const ready = join(tmp, 'trap-armed')
    try {
      const spec: AcpRunSpec = {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        env: { MOCK_TRAP_SIGTERM: '1', MOCK_TEXT: 'x', MOCK_READY_FILE: ready },
        // Short on BOTH tiers: the trap ignores EOF and SIGTERM, so dispose must
        // burn the EOF window, then the SIGTERM window, then SIGKILL — keep each
        // small so the whole ladder finishes well within the 4000ms bound.
        disposeEofGraceMs: 150,
        disposeGraceMs: 150,
        spawn: spawnSubprocess,
      }
      const run = await startAcpRun(request(), spec)
      // Wait until the child has BOOTED AND ARMED THE TRAP (a condition, not a
      // sleep) — otherwise SIGTERM races the trap install and the default handler
      // terminates the child, never exercising the escalation.
      await waitForFile(ready)
      // Don't await result (the child hangs). Dispose must still return promptly
      // via the SIGKILL escalation — bound it so a regression (no escalation)
      // fails loud instead of hanging the suite.
      await expect(Promise.race([
        run.dispose(),
        new Promise((_r, reject) => { setTimeout(() => { reject(new Error('dispose did not return — no SIGKILL escalation')) }, 4000) }),
      ])).resolves.toBeUndefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('dispose gives the child an EOF window that outlasts the SIGTERM grace (graceful flush)', async () => {
    // The real acp-agent flushes ASYNCHRONOUSLY on stdin EOF (its bridge tears
    // down on connection close, NOT on a signal) — and it has no SIGTERM handler.
    // Its EOF teardown can itself await a signal-trapping grandchild (a bash
    // subprocess in its own SIGTERM→SIGKILL grace) plus a flush, so the EOF window
    // must be a SEPARATE, WIDER grace than the SIGTERM tier — not the same value.
    // The mock models a flush that takes LONGER than the SIGTERM grace but well
    // under the EOF grace: it lands only because tier 1 waits eofGraceMs, not
    // graceMs. (If dispose reused the small SIGTERM grace for the EOF wait — the
    // round-2 bug — SIGTERM would fire mid-flush and the marker would be missing.)
    const tmp = mkdtempSync(join(tmpdir(), 'acp-eof-'))
    const ready = join(tmp, 'ready')
    const flushed = join(tmp, 'flushed')
    try {
      const spec: AcpRunSpec = {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        // MOCK_HANG so the prompt never resolves on its own — we tear down a live
        // child. The flush beat (400ms) outlasts the 50ms SIGTERM grace but fits
        // the 2000ms EOF grace; the marker lands iff the EOF tier honored its own
        // wider grace.
        env: {
          MOCK_HANG: '1', MOCK_TEXT: 'x', MOCK_READY_FILE: ready,
          MOCK_FLUSH_ON_EOF: flushed, MOCK_FLUSH_DELAY_MS: '400',
        },
        disposeEofGraceMs: 2000,
        disposeGraceMs: 50,
        spawn: spawnSubprocess,
      }
      const run = await startAcpRun(request(), spec)
      // Wait until the child is fully booted with its prompt in flight (its ACP
      // stdin reader is attached), so dispose's stdin EOF reaches a live child.
      await waitForFile(ready)
      await run.dispose()
      // dispose returned via the natural-exit tier — the EOF-driven flush landed
      // despite taking longer than the SIGTERM grace.
      expect(existsSync(flushed)).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('terminates a child that ignores EOF using the host platform semantics', async () => {
    // POSIX uses the catchable SIGTERM tier and records the marker. Windows has
    // no distinct graceful signal, so disposal skips directly to forced exit.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-ignore-eof-'))
    const ready = join(tmp, 'ready')
    const sigterm = join(tmp, 'sigterm')
    try {
      const spec: AcpRunSpec = {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        env: {
          MOCK_HANG: '1', MOCK_IGNORE_EOF: '1', MOCK_TEXT: 'x',
          MOCK_READY_FILE: ready, MOCK_SIGTERM_FILE: sigterm,
        },
        // Tiny EOF grace so the ignored-EOF window elapses quickly.
        disposeEofGraceMs: 150,
        disposeGraceMs: 2000,
        spawn: spawnSubprocess,
      }
      const run = await startAcpRun(request(), spec)
      await waitForFile(ready)
      // Bound it so a hang fails loud rather than stalling the suite.
      await expect(Promise.race([
        run.dispose(),
        new Promise((_r, reject) => { setTimeout(() => { reject(new Error('dispose did not return')) }, 5000) }),
      ])).resolves.toBeUndefined()
      expect(existsSync(sigterm)).toBe(process.platform !== 'win32')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects after cleanup when the signal aborts during newSession', async () => {
    // Gate the child at newSession: it signals `ready` and blocks until `go`.
    // We cancel WHILE newSession is pending (sessionId still undefined, so the
    // backend cannot send session/cancel) — the `cancelled` flag alone must
    // settle the run aborted after newSession resolves, never issuing the prompt.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-early-'))
    const ready = join(tmp, 'ready')
    const go = join(tmp, 'go')
    try {
      const ctx = await setup({ MOCK_NEWSESSION_READY: ready, MOCK_NEWSESSION_GO: go, MOCK_TEXT: 'should not run' })
      const controller = new AbortController()
      const starting = ctx.subagents.start('acp', request('p', controller.signal))
      await waitForFile(ready) // newSession is now in flight, sessionId undefined
      controller.abort('early')
      writeFileSync(go, 'go') // let newSession resolve
      await expect(starting).rejects.toThrow('aborted before the ACP child started')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('bridges the request signal to a session/cancel mid-run', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'acp-signal-'))
    const readyFile = join(tmp, 'ready')
    try {
      const controller = new AbortController()
      const ctx = await setup({ MOCK_TEXT: 'partial', MOCK_HANG: '1', MOCK_READY_FILE: readyFile })
      const run = await ctx.subagents.start('acp', request('p', controller.signal))
      await waitForFile(readyFile)
      controller.abort()
      const result = await run.result
      expect(result.stopReason).toBe('aborted')
      expect(result.diagnostic).toBeUndefined()
      await run.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('auto-rejects a permission prompt by default (child settles cancelled→aborted)', async () => {
    const ctx = await setup({ MOCK_TEXT: 'x', MOCK_PERMISSION: '1', MOCK_TOOL_KIND: 'execute' }, 'reject')
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    // The child asked permission, the backend rejected, the child returned cancelled.
    expect(result.stopReason).toBe('aborted')
    expect(result.diagnostic).toBe(expectedPermission('reject', 'execute', 'denied'))
    await run.dispose()
  })

  it('auto-approves a permission prompt under the allow policy', async () => {
    const ctx = await setup({ MOCK_TEXT: 'approved answer', MOCK_PERMISSION: '1', MOCK_STOP: 'end_turn' }, 'allow')
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.diagnostic).toBeUndefined()
    expect(text(result.output)).toBe('approved answer')
    await run.dispose()
  })

  it('falls back to cancelled under the allow policy when the child offers no allow option', async () => {
    // The child asks permission but offers ONLY reject-shaped options, so an
    // allow-policy client finds nothing to select and must answer cancelled.
    const ctx = await setup({ MOCK_PERMISSION: '1', MOCK_NO_ALLOW: '1' }, 'allow')
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(result.diagnostic).toBe(expectedPermission('allow', 'unknown', 'denied'))
    await run.dispose()
  })

  it('appends a rejected permission fact to a later remote failure', async () => {
    const ctx = await setup({
      MOCK_PERMISSION: '1',
      MOCK_PERMISSION_IGNORE_DECISION: '1',
      MOCK_TOOL_KIND: 'edit',
      MOCK_STOP: 'max_turn_requests',
    }, 'reject')
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe(
      `${expectedFailure('stage: prompt; category: remote-limit; stop reason: max_turn_requests')}\n`
      + expectedPermission('reject', 'edit', 'denied'),
    )
    await run.dispose()
  })

  it('appends an allowed permission fact only when the run later fails', async () => {
    const ctx = await setup({
      MOCK_PERMISSION: '1',
      MOCK_PERMISSION_IGNORE_DECISION: '1',
      MOCK_TOOL_KIND: 'execute',
      MOCK_STOP: 'max_turn_requests',
    }, 'allow')
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe(
      `${expectedFailure('stage: prompt; category: remote-limit; stop reason: max_turn_requests')}\n`
      + expectedPermission('allow', 'execute', 'allowed'),
    )
    await run.dispose()
  })

  it('consumes a non-message update (a thought) without adding it to the output', async () => {
    // The child streams an agent_thought_chunk before its answer; the backend
    // must consume it but NOT include it in the result output.
    const ctx = await setup({ MOCK_THOUGHT: '1', MOCK_TEXT: 'final answer', MOCK_STOP: 'end_turn' })
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    // Only the message text, NOT the thought.
    expect(text(result.output)).toBe('final answer')
    await run.dispose()
  })

  it('classifies a prompt transport failure without copying SDK text', async () => {
    const run = await startAcpRun(request('private prompt text'), {
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      permission: 'reject',
      env: { MOCK_HANG: '1' },
      disposeEofGraceMs: 100,
      disposeGraceMs: 100,
      spawn: spec => closeProtocolOnPrompt(spawnSubprocess(spec)),
    })
    const result = await run.result
    expect(result).toEqual({
      output: [],
      diagnostic: expectedFailure('stage: prompt; category: transport'),
      stopReason: 'error',
    })
    expect(result.diagnostic).not.toContain('private prompt text')
    await run.dispose()
  })

  it('lets local cancellation interrupt prompt-failure process observation', async () => {
    const controller = new AbortController()
    const protocolEnded = Promise.withResolvers<undefined>()
    let boundedExitWaits = 0
    const run = await startAcpRun(request('p', controller.signal), {
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      permission: 'reject',
      env: { MOCK_HANG: '1' },
      disposeEofGraceMs: 100,
      disposeGraceMs: 5000,
      spawn: (spec) => {
        const child = spawnSubprocess(spec)
        return closeProtocolOnPrompt(
          tapBoundedExitWait(child, () => { boundedExitWaits += 1 }),
          () => { protocolEnded.resolve(undefined) },
        )
      },
    })
    await protocolEnded.promise
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    controller.abort()
    await expect(Promise.race([
      run.result,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => { reject(new Error('cancellation waited for process observation')) }, 500)
      }),
    ])).resolves.toEqual({ output: [], stopReason: 'aborted' })
    expect(boundedExitWaits).toBe(0)
    await run.dispose()
  })

  it('preserves partial output and structured process facts when the child exits', async () => {
    const ctx = await setup({ MOCK_TEXT: 'partial answer', MOCK_CRASH_AFTER_CHUNK: '1' })
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result).toEqual({
      output: [{ type: 'text', text: 'partial answer' }],
      diagnostic: expectedFailure('stage: process; category: process-exit; exit code: 17'),
      stopReason: 'error',
    })
    await run.dispose()
  })

  it('reports a signal-only process outcome', async () => {
    const run = await startAcpRun(request(), {
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      permission: 'reject',
      env: { MOCK_CRASH_AFTER_CHUNK: '1' },
      disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
      disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
      spawn: spec => replaceProcessOutcome(
        spawnSubprocess(spec),
        { exitCode: null, signal: 'SIGTERM' },
      ),
    })
    const result = await run.result
    expect(result).toEqual({
      output: [{ type: 'text', text: 'mock child answer' }],
      diagnostic: expectedFailure('stage: process; category: process-exit; signal: SIGTERM'),
      stopReason: 'error',
    })
    await run.dispose()
  })

  it('rejects a spawn failure after provider-owned cleanup', async () => {
    const privateCommand = '/nonexistent/private/SECRET_TOKEN/acp-agent'
    const error = await startAcpRun(
      request(),
      { command: privateCommand, args: [], cwd: process.cwd(), permission: 'reject', env: {}, disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS, disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS, spawn: spawnSubprocess },
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      `subagent-acp: ${expectedFailure('stage: process; category: process-start')}`,
    )
    expect((error as Error).message).not.toContain(privateCommand)
  })

  it('sanitizes a synchronous subprocess-provider spawn rejection', async () => {
    const rawMessage = 'spawn rejected /private/path SECRET_TOKEN'
    const errors: string[] = []
    const error = await startAcpRun(request(), {
      command: 'unused',
      args: [],
      cwd: process.cwd(),
      permission: 'reject',
      env: {},
      disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
      disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
      spawn: () => { throw new Error(rawMessage) },
      onError: (failure) => { errors.push(failure.message) },
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      `subagent-acp: ${expectedFailure('stage: process; category: process-start')}`,
    )
    expect((error as Error).message).not.toContain(rawMessage)
    expect(errors).toEqual([rawMessage])
  })

  it.skipIf(process.platform === 'win32')('plugin-config dispose graces reach the run (SIGKILL escalation through the provider)', async () => {
    // Same trap scenario as the direct startAcpRun escalation test, but the
    // graces arrive via the PLUGIN CONFIG through the registered provider — so a
    // regression that stops threading config into AcpRunSpec (falling back to
    // the 6s/3s defaults) blows past the 4000ms bound and fails loud.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-cfg-trap-'))
    const ready = join(tmp, 'trap-armed')
    try {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(acp, {
        providerName: 'acp',
        command: process.execPath,
        args: [mockServer],
        permission: 'reject',
        env: { MOCK_TRAP_SIGTERM: '1', MOCK_TEXT: 'x', MOCK_READY_FILE: ready },
        disposeEofGraceMs: 150,
        disposeGraceMs: 150,
      })
      const run = await ctx.subagents.start('acp', request())
      await waitForFile(ready)
      await expect(Promise.race([
        run.dispose(),
        new Promise((_r, reject) => { setTimeout(() => { reject(new Error('dispose did not return — config graces not threaded to the run')) }, 4000) }),
      ])).resolves.toBeUndefined()
      await ctx.fiber.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects a dispose grace outside the Node timer range at load', async () => {
    for (const bad of [
      { disposeEofGraceMs: 0 },
      { disposeGraceMs: -1 },
      { disposeEofGraceMs: Number.NaN },
      { disposeGraceMs: Number.POSITIVE_INFINITY },
      { disposeEofGraceMs: MAX_TIMER_DELAY_MS + 1 },
      { disposeGraceMs: MAX_TIMER_DELAY_MS + 1 },
    ]) {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await expect(ctx.plugin(acp, { providerName: 'acp', command: 'true', args: [], permission: 'reject', env: {}, ...bad }))
        .rejects.toThrow(new RegExp(`subagent-acp: dispose(?:Eof)?GraceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`))
      await ctx.fiber.dispose()
    }
  })

  it('rejects a startup failure via the provider load path', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(acp, {
      providerName: 'acp',
      command: '/nonexistent/acp-agent-binary',
      args: [],
      permission: 'reject',
      env: {},
    })
    await expect(ctx.subagents.start('acp', request())).rejects.toThrow(
      `subagent-acp: ${expectedFailure('stage: process; category: process-start')}`,
    )
  })

  it('keeps permission diagnostics isolated across concurrent runs', async () => {
    const start = (permission: 'allow' | 'reject', kind: 'edit' | 'execute') => startAcpRun(
      request(),
      {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission,
        env: {
          MOCK_PERMISSION: '1',
          MOCK_PERMISSION_IGNORE_DECISION: '1',
          MOCK_TOOL_KIND: kind,
          MOCK_STOP: 'max_turn_requests',
        },
        disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
        disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
        spawn: spawnSubprocess,
      },
    )
    const [allowed, denied] = await Promise.all([
      start('allow', 'execute'),
      start('reject', 'edit'),
    ])
    const [allowedResult, deniedResult] = await Promise.all([allowed.result, denied.result])
    expect(allowedResult.diagnostic).toContain(expectedPermission('allow', 'execute', 'allowed'))
    expect(allowedResult.diagnostic).not.toContain('policy: reject')
    expect(deniedResult.diagnostic).toContain(expectedPermission('reject', 'edit', 'denied'))
    expect(deniedResult.diagnostic).not.toContain('policy: allow')
    await Promise.all([allowed.dispose(), denied.dispose()])
  })

  it('wraps a teardown rejection with safe facts and keeps the raw cause in Host diagnostics', async () => {
    const rawMessage = 'teardown leaked /private/path SECRET_TOKEN'
    const errors: string[] = []
    let realChild: SubprocessHandle | undefined
    const run = await startAcpRun(request(), {
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      permission: 'reject',
      env: { MOCK_HANG: '1', MOCK_IGNORE_CANCEL: '1' },
      disposeEofGraceMs: 10,
      disposeGraceMs: 10,
      spawn: (spec) => {
        const child = spawnSubprocess(spec)
        realChild = child
        return rejectFinalExitWait(child, rawMessage)
      },
      onError: (error) => { errors.push(error.message) },
    })
    const error = await run.dispose().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      `subagent-acp: ${expectedFailure('stage: teardown; category: unknown')}`,
    )
    expect((error as Error).message).not.toContain(rawMessage)
    expect(errors).toContain(rawMessage)
    await realChild?.done
    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'aborted' })
  })

  it('adds an observed process outcome to a teardown failure', async () => {
    let realChild: SubprocessHandle | undefined
    const run = await startAcpRun(request(), {
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      permission: 'reject',
      env: { MOCK_HANG: '1', MOCK_IGNORE_CANCEL: '1' },
      disposeEofGraceMs: 10,
      disposeGraceMs: 10,
      spawn: (spec) => {
        const child = spawnSubprocess(spec)
        realChild = child
        return rejectFinalExitWaitAfterExit(child, 'post-exit wait failed')
      },
    })
    const error = await run.dispose().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(
      'subagent-acp: Subagent failure (provider: ACP; stage: teardown; category: process-exit;',
    )
    expect((error as Error).message).toMatch(/(?:exit code|signal): /)
    await realChild?.done
  })

  it('reports a flattened child failure through onError (preserved, not silently lost)', async () => {
    // The seam forbids `result` rejecting, so a child-level failure is flattened
    // to a stop reason — onError must still surface the original error so a real
    // fault is logged, not swallowed. The child exits after its session is
    // published but while prompt is in flight.
    const errors: { message: string; stopReason: string }[] = []
    const run = await startAcpRun(
      request(),
      {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        env: { MOCK_CRASH_ON_PROMPT: '1' },
        disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
        disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
        spawn: spawnSubprocess,
        onError: (error, stopReason) => { errors.push({ message: error.message, stopReason }) },
      },
    )
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe(
      expectedFailure('stage: process; category: process-exit; exit code: 1'),
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]!.stopReason).toBe('error')
    expect(errors[0]!.message.length).toBeGreaterThan(0)
    await run.dispose()
  })

  it('logs a flattened child failure through the registered provider', async () => {
    const ctx = await setup({ MOCK_CRASH_ON_PROMPT: '1' })
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe(
      expectedFailure('stage: process; category: process-exit; exit code: 1'),
    )
    expect(warnings).toEqual([
      expect.stringContaining('subagent-acp "acp": child run failed (error):'),
    ])
    await run.dispose()
  })

  it('resolves error (never rejects) even when the onError sink itself throws', async () => {
    // onError is a caller-supplied callback boundary: its own exception must be
    // contained, or it would reject `result` and break the seam's "result never
    // rejects" contract that the flattening above exists to uphold.
    const run = await startAcpRun(
      request(),
      {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        env: { MOCK_CRASH_ON_PROMPT: '1' },
        disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
        disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
        spawn: spawnSubprocess,
        onError: () => { throw new Error('sink boom') },
      },
    )
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe(
      expectedFailure('stage: process; category: process-exit; exit code: 1'),
    )
    await run.dispose()
  })

  it('settles aborted when the child crashes (tears the pipe) AFTER a cancel', async () => {
    // The child hangs, we cancel, and instead of answering the child exits hard
    // — the pending prompt RPC rejects. With a cancel already requested, the
    // backend's catch path must settle `aborted` (the failure is the cancel
    // surfacing as a torn pipe), not `error`.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-crash-'))
    const ready = join(tmp, 'ready')
    try {
      const ctx = await setup({ MOCK_TEXT: 'partial', MOCK_HANG: '1', MOCK_CRASH_ON_CANCEL: '1', MOCK_READY_FILE: ready })
      const controller = new AbortController()
      const run = await ctx.subagents.start('acp', request('p', controller.signal))
      await waitForFile(ready)
      controller.abort('crash it')
      const result = await run.result
      expect(result.stopReason).toBe('aborted')
      expect(result.diagnostic).toBeUndefined()
      await run.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('settles aborted on signal even when the child IGNORES session/cancel', async () => {
    // The signal contract requires `result` to settle `aborted`. A child that hangs
    // its prompt AND ignores session/cancel must not wedge the parent — the
    // backend's own cancel-settle path resolves `aborted` without the child's
    // cooperation, and dispose() still reaps the process.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-ignorecancel-'))
    const ready = join(tmp, 'ready')
    try {
      const ctx = await setup({ MOCK_TEXT: 'partial', MOCK_HANG: '1', MOCK_IGNORE_CANCEL: '1', MOCK_READY_FILE: ready })
      const controller = new AbortController()
      const run = await ctx.subagents.start('acp', request('p', controller.signal))
      await waitForFile(ready)
      controller.abort('test')
      // Bound it: a regression (cancel only notifies the child, which ignores it)
      // would hang result forever — fail loud instead of stalling the suite.
      const result = await Promise.race([
        run.result,
        new Promise<never>((_r, reject) => { setTimeout(() => { reject(new Error('result did not settle on cancel — backend waited on the child')) }, 4000) }),
      ])
      expect(result.stopReason).toBe('aborted')
      expect(result.diagnostic).toBeUndefined()
      await run.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('advertises no start-time capabilities (out-of-process child)', async () => {
    const ctx = await setup()
    const provider = ctx.subagents.getProvider('acp')!
    expect(provider.capabilities).toEqual({
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    })
  })

  it('unregisters the provider when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(acp, { providerName: 'acp', command: 'x', args: [], permission: 'reject', env: {} })
    expect(ctx.subagents.list()).toEqual(['acp'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in acp).toBe(false)
    expect(acp.name).toBe('subagent-acp')
    expect(acp.inject).toEqual(['subagents', 'subprocess'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(acp) as Record<string, unknown>
    expect(unwrapped).toBe(acp)
    expect(unwrapped.name).toBe('subagent-acp')
    expect(typeof unwrapped.apply).toBe('function')
  })
})
