/** Sends, reads, signals and release over a scripted Agent terminal on a fake clock. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTerminalError } from '@deepseek-ai/dsh-api-terminal-controller'
import { TerminalError } from '@deepseek-ai/dsh-terminal'
import type { TerminalSendResult } from '@deepseek-ai/dsh-terminal'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { POLICY_CHANGED, PanelTerminalSession, TAKEN_OVER, changedWithin, modelError, samePolicy, statusOf } from '../src/session.ts'
import { FakeTerminal, SHELL_PID } from './fake.ts'

const options = { promptSilenceMs: 300, probeIntervalMs: 1000, idleSilenceMs: 3000, timeoutMs: 30_000, maxReadBytes: 1000 }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) })
afterEach(() => { vi.useRealTimers() })

const launched: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: '/workspace' }

function session(terminal = new FakeTerminal(), overrides: Partial<typeof options> = {}) {
  const policy = { current: launched }
  const panel = new PanelTerminalSession(terminal, 'motd', { ...options, ...overrides }, { launched, current: () => policy.current })
  return { terminal, session: panel, policy }
}

async function settled(done: Promise<TerminalSendResult>): Promise<TerminalSendResult | undefined> {
  let result: TerminalSendResult | undefined
  void done.then((value) => { result = value })
  await vi.advanceTimersByTimeAsync(0)
  return result
}

describe('sends', () => {
  it('returns stdin_read once output is quiet and the shell owns the foreground again', async () => {
    const { terminal, session: panel } = session()
    const send = panel.startSend({ text: 'ls', submit: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(terminal.write).toHaveBeenCalledExactlyOnceWith('ls\r')
    terminal.output(' ls', 'notes.txt', '$')
    await vi.advanceTimersByTimeAsync(299)
    expect(await settled(send.done)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(await send.done).toEqual({ viewport: '$ ls\nnotes.txt\n$', waitReason: 'stdin_read', sessionStatus: { kind: 'running' }, truncated: false })
    expect(terminal.inspectForeground).toHaveBeenCalledOnce()
    expect(terminal.drain).toHaveBeenCalledTimes(2)
    expect(terminal.marks.every(mark => mark.disposed)).toBe(true)
  })

  it('reports a quiet command as inferred_idle after idleSilenceMs, probing at most once per interval', async () => {
    const { terminal, session: panel } = session()
    terminal.foreground = { processGroupId: 200, inputWaiting: false }
    const send = panel.startSend({ text: 'sleep 20', submit: true })
    await vi.advanceTimersByTimeAsync(2999)
    expect(await settled(send.done)).toBeUndefined()
    expect(terminal.inspectForeground).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect((await send.done).waitReason).toBe('inferred_idle')
  })

  it('returns stdin_read when a foreground program waits for terminal input', async () => {
    const { terminal, session: panel } = session()
    terminal.foreground = { processGroupId: 300, inputWaiting: true }
    const send = panel.startSend({ text: 'python3', submit: true })
    await vi.advanceTimersByTimeAsync(300)
    expect((await send.done).waitReason).toBe('stdin_read')
  })

  it('restarts the silence when output arrives during an inspection', async () => {
    const { terminal, session: panel } = session()
    terminal.inspectForeground.mockImplementationOnce(async () => {
      terminal.output('', 'late output')
      return { processGroupId: SHELL_PID, inputWaiting: false }
    })
    const send = panel.startSend({ text: 'make', submit: true })
    await vi.advanceTimersByTimeAsync(300)
    expect(await settled(send.done)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(999)
    expect(await settled(send.done)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(await send.done).toMatchObject({ waitReason: 'stdin_read', viewport: '$\nlate output' })
    expect(terminal.inspectForeground).toHaveBeenCalledTimes(2)
  })

  it('treats a failed inspection as unknown and keeps waiting for silence', async () => {
    const { terminal, session: panel } = session()
    terminal.inspectForeground.mockRejectedValue(new Error('ps failed'))
    const send = panel.startSend({ text: 'make', submit: true })
    await vi.advanceTimersByTimeAsync(3000)
    expect((await send.done).waitReason).toBe('inferred_idle')
  })

  it('returns at the deadline while output keeps arriving', async () => {
    const { terminal, session: panel } = session(undefined, { timeoutMs: 1000, idleSilenceMs: 500 })
    const send = panel.startSend({ text: 'yes', submit: true })
    for (let tick = 0; tick < 10; tick++) {
      await vi.advanceTimersByTimeAsync(100)
      terminal.output('', 'y')
    }
    expect((await send.done).waitReason).toBe('timeout')
  })

  it('reports the end of the shell as session_exit with its exit code', async () => {
    const { terminal, session: panel } = session()
    const send = panel.startSend({ text: 'exit 3', submit: true })
    await vi.advanceTimersByTimeAsync(10)
    terminal.update({ state: 'exited', exitCode: 3 })
    expect(await send.done).toMatchObject({ waitReason: 'session_exit', sessionStatus: { kind: 'exited', exitCode: 3, signal: null } })
  })

  it('returns no viewport when the screen is released before settlement', async () => {
    const { terminal, session: panel } = session()
    const send = panel.startSend({ text: 'exit', submit: true })
    await vi.advanceTimersByTimeAsync(10)
    terminal.released = true
    terminal.update({ state: 'failed', exitCode: null })
    expect(await send.done).toEqual({ viewport: '', waitReason: 'session_exit', sessionStatus: { kind: 'exited', exitCode: null, signal: null }, truncated: false })
  })

  it('rejects when the screen is gone before the send starts or rendering fails unexpectedly', async () => {
    const closed = session()
    closed.terminal.released = true
    await expect(closed.session.startSend({ text: 'ls', submit: true }).done).rejects.toMatchObject({ code: 'unavailable' })
    const broken = session()
    const send = broken.session.startSend({ text: 'ls', submit: true })
    await vi.advanceTimersByTimeAsync(10)
    broken.terminal.renderFailure = new Error('emulator failed')
    broken.terminal.update({ state: 'exited', exitCode: 0 })
    await expect(send.done).rejects.toThrow('emulator failed')
  })

  it('writes nothing for an empty send and writes text without Enter when submit is false', async () => {
    const { terminal, session: panel } = session()
    const poll = panel.startSend({ text: '', submit: false })
    await vi.advanceTimersByTimeAsync(300)
    expect((await poll.done).waitReason).toBe('stdin_read')
    expect(terminal.write).not.toHaveBeenCalled()
    const partial = panel.startSend({ text: 'echo "', submit: false })
    await vi.advanceTimersByTimeAsync(300)
    await partial.done
    expect(terminal.write).toHaveBeenCalledExactlyOnceWith('echo "')
  })
})

describe('incremental output', () => {
  it('delivers complete lines once and leaves the rest for the viewport', async () => {
    const { terminal, session: panel } = session()
    terminal.foreground = { processGroupId: 200, inputWaiting: false }
    const send = panel.startSend({ text: 'make', submit: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(send.readOutput()).toEqual({ delta: '', truncated: false })
    terminal.output(' make', 'compiling a', 'compiling b', 'progress 10%')
    expect(send.readOutput()).toEqual({ delta: '$ make\ncompiling a\ncompiling b\n', truncated: false })
    expect(send.readOutput()).toEqual({ delta: '', truncated: false })
    terminal.output('0', 'done', '$')
    expect(send.readOutput()).toEqual({ delta: 'progress 10%0\ndone\n', truncated: false })
    terminal.foreground = { processGroupId: SHELL_PID, inputWaiting: false }
    await vi.advanceTimersByTimeAsync(1000)
    expect(await send.done).toMatchObject({ viewport: '$', truncated: false })
    expect(send.readOutput()).toEqual({ delta: '', truncated: false })
  })

  it('reports output dropped from scrollback and bounds deltas and viewports to the newest bytes', async () => {
    const { terminal, session: panel } = session(undefined, { maxReadBytes: 8 })
    terminal.foreground = { processGroupId: 200, inputWaiting: false }
    const send = panel.startSend({ text: 'cat', submit: true })
    await vi.advanceTimersByTimeAsync(10)
    terminal.output('', 'old', 'kept', 'x')
    terminal.trim(1)
    expect(send.readOutput()).toEqual({ delta: 'ld\nkept\n', truncated: true })
    terminal.output('', 'y', 'z')
    terminal.trim(3)
    expect(send.readOutput()).toEqual({ delta: 'y\n', truncated: true })
    terminal.output('', 'w')
    terminal.trim(2)
    expect(send.readOutput()).toEqual({ delta: '', truncated: true })
    terminal.output('', '终端输出', '$')
    terminal.foreground = { processGroupId: SHELL_PID, inputWaiting: false }
    await vi.advanceTimersByTimeAsync(1000)
    expect(await send.done).toMatchObject({ viewport: '输出\n$', truncated: true })
  })
})

describe('cancellation', () => {
  it('interrupts the command its input started, once, and reports settlement afterwards', async () => {
    const { terminal, session: panel } = session()
    terminal.foreground = { processGroupId: 200, inputWaiting: false }
    const abort = new AbortController()
    const send = panel.startSend({ text: 'sleep 20', submit: true, signal: abort.signal })
    await vi.advanceTimersByTimeAsync(10)
    abort.abort()
    expect(send.cancel()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(terminal.signal).toHaveBeenCalledExactlyOnceWith('SIGINT')
    terminal.output('^C', '$')
    terminal.foreground = { processGroupId: SHELL_PID, inputWaiting: false }
    await vi.advanceTimersByTimeAsync(300)
    expect((await send.done).waitReason).toBe('stdin_read')
    expect(send.cancel()).toBe(false)
  })

  it('skips the write when cancelled before it and contains a refused interrupt', async () => {
    const { terminal, session: panel } = session()
    const drained = Promise.withResolvers<undefined>()
    terminal.drain.mockReturnValueOnce(drained.promise)
    const early = panel.startSend({ text: 'rm -rf build', submit: true })
    expect(early.readOutput()).toEqual({ delta: '', truncated: false })
    expect(early.cancel()).toBe(true)
    drained.resolve(undefined)
    await vi.advanceTimersByTimeAsync(300)
    expect((await early.done).waitReason).toBe('stdin_read')
    expect(terminal.write).not.toHaveBeenCalled()
    expect(terminal.signal).not.toHaveBeenCalled()
    terminal.signal.mockRejectedValueOnce(new AgentTerminalError('user-control', 'The user has taken over this terminal'))
    const late = panel.startSend({ text: 'make', submit: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(late.cancel()).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect((await late.done).waitReason).toBe('stdin_read')
  })
})

describe('session operations', () => {
  it('refuses sends that cannot start', async () => {
    const { terminal, session: panel } = session()
    const first = panel.startSend({ text: 'make', submit: true })
    expect(() => panel.startSend({ text: 'ls', submit: true })).toThrow(TerminalError)
    await vi.advanceTimersByTimeAsync(300)
    await first.done
    expect(() => panel.startSend({ text: 'ls', submit: true, signal: AbortSignal.abort() })).toThrow('aborted before write')
    terminal.update({ control: 'user' })
    expect(() => panel.startSend({ text: 'ls', submit: true })).toThrow(TAKEN_OVER)
    terminal.update({ state: 'exited', exitCode: 0 })
    expect(() => panel.startSend({ text: 'ls', submit: true })).toThrow('has exited')
  })

  it('refuses input once the Session sandbox policy changes and keeps reads, signals and closing', async () => {
    const { terminal, session: panel, policy } = session()
    policy.current = { mode: 'read-only', workspaceRoot: '/workspace' }
    expect(() => panel.startSend({ text: 'rm -rf build', submit: true })).toThrow(POLICY_CHANGED)
    expect(terminal.write).not.toHaveBeenCalled()
    expect(panel.read({})).toMatchObject({ text: '$' })
    expect(await panel.signal('SIGINT')).toEqual({ delivered: true, targetPgid: 77 })
    policy.current = { ...launched }
    const send = panel.startSend({ text: 'ls', submit: true })
    await vi.advanceTimersByTimeAsync(300)
    expect(await send.done).toMatchObject({ waitReason: 'stdin_read' })
    policy.current = { mode: 'danger-full-access', workspaceRoot: '/workspace' }
    expect(() => panel.startSend({ text: 'ls', submit: true })).toThrow(POLICY_CHANGED)
    await panel.close('model request')
    expect(terminal.close).toHaveBeenCalledOnce()
  })

  it('explains a takeover that refuses the write', async () => {
    const { terminal, session: panel } = session()
    terminal.write.mockRejectedValueOnce(new AgentTerminalError('user-control', 'The user has taken over this terminal'))
    await expect(panel.startSend({ text: 'ls', submit: true }).done).rejects.toThrow(TAKEN_OVER)
  })

  it('reads newest-relative pages within the byte bound and validates positions', () => {
    const { terminal, session: panel } = session()
    terminal.screen = ['one', 'two', '$']
    expect(panel.read({})).toMatchObject({ text: 'one\ntwo\n$', totalLines: 3 })
    expect(terminal.read).toHaveBeenLastCalledWith({ offset: 0, count: 500, maxBytes: 1000 })
    panel.read({ offset: 1, count: 1 })
    expect(terminal.read).toHaveBeenLastCalledWith({ offset: 1, count: 1, maxBytes: 1000 })
    expect(() => panel.read({ offset: -1 })).toThrow('offset')
    expect(() => panel.read({ count: 0 })).toThrow('count')
  })

  it('signals the foreground group until the person takes over', async () => {
    const { terminal, session: panel } = session()
    expect(await panel.signal('SIGTERM')).toEqual({ delivered: true, targetPgid: 77 })
    terminal.signal.mockRejectedValueOnce(new AgentTerminalError('user-control', 'The user has taken over this terminal'))
    await expect(panel.signal('SIGINT')).rejects.toThrow(TAKEN_OVER)
    terminal.signal.mockRejectedValueOnce(new AgentTerminalError('not-running', 'The terminal is not running'))
    await expect(panel.signal('SIGINT')).rejects.toMatchObject({ code: 'not-running' })
  })

  it('reports status and the shell process id', () => {
    const { terminal, session: panel } = session()
    expect(panel.pid).toBe(SHELL_PID)
    expect(panel.motd).toBe('motd')
    expect(panel.status()).toEqual({ kind: 'running' })
    terminal.update({ state: 'exited', exitCode: 2 })
    expect(panel.status()).toEqual({ kind: 'exited', exitCode: 2, signal: null })
  })
})

describe('closing', () => {
  it('closes a terminal the Agent controls and settles its send', async () => {
    const { terminal, session: panel } = session()
    terminal.foreground = { processGroupId: 200, inputWaiting: false }
    const send = panel.startSend({ text: 'npm run dev', submit: true })
    await vi.advanceTimersByTimeAsync(10)
    await panel.close('model request')
    expect(terminal.close).toHaveBeenCalledOnce()
    expect(await send.done).toMatchObject({ waitReason: 'session_exit', sessionStatus: { kind: 'exited' } })
    expect(() => panel.startSend({ text: 'ls', submit: true })).toThrow('closing')
    await expect(panel.signal('SIGINT')).rejects.toThrow('closing')
  })

  it('releases a terminal the person took over without ending it', async () => {
    const { terminal, session: panel } = session()
    terminal.foreground = { processGroupId: 200, inputWaiting: false }
    const send = panel.startSend({ text: 'npm run dev', submit: true })
    await vi.advanceTimersByTimeAsync(10)
    terminal.update({ control: 'user' })
    await panel.close('model request')
    expect(terminal.close).not.toHaveBeenCalled()
    expect(await send.done).toMatchObject({ waitReason: 'session_exit', sessionStatus: { kind: 'running' } })
  })

  it('leaves a terminal taken over during closing to the person and reports other close failures', async () => {
    const raced = session()
    raced.terminal.close.mockRejectedValueOnce(new AgentTerminalError('user-control', 'The user has taken over this terminal'))
    await expect(raced.session.close('model request')).resolves.toBeUndefined()
    const failed = session()
    failed.terminal.foreground = { processGroupId: 200, inputWaiting: false }
    const send = failed.session.startSend({ text: 'npm run dev', submit: true })
    await vi.advanceTimersByTimeAsync(10)
    failed.terminal.close.mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(failed.session.close('model request')).rejects.toThrow('cleanup failed')
    expect(await settled(send.done)).toMatchObject({ waitReason: 'session_exit', sessionStatus: { kind: 'running' } })
  })
})

describe('helpers', () => {
  it('compares the mode, workspace root and extra writable roots of two policies', () => {
    const roots = { ...launched, additionalWritableRoots: ['/a', '/b'] }
    expect(samePolicy(launched, { ...launched })).toBe(true)
    expect(samePolicy(roots, { ...launched, additionalWritableRoots: ['/b', '/a'] })).toBe(true)
    expect(samePolicy(launched, { ...launched, mode: 'read-only' })).toBe(false)
    expect(samePolicy(launched, { ...launched, workspaceRoot: '/elsewhere' })).toBe(false)
    expect(samePolicy(roots, launched)).toBe(false)
  })

  it('passes errors other than a takeover through unchanged', () => {
    const failure = new Error('provider failed')
    expect(modelError(failure)).toBe(failure)
    const unavailable = new AgentTerminalError('unavailable', 'The terminal was closed')
    expect(modelError(unavailable)).toBe(unavailable)
    expect(modelError(new AgentTerminalError('user-control', 'taken'))).toMatchObject({ message: TAKEN_OVER })
  })

  it('maps a failed launch to an exit without a code', () => {
    expect(statusOf({ ...new FakeTerminal().info, state: 'failed', exitCode: null })).toEqual({ kind: 'exited', exitCode: null, signal: null })
  })

  it('returns at once for an observed change and rethrows unexpected wait failures', async () => {
    const terminal = new FakeTerminal()
    terminal.output('', 'x')
    expect(await changedWithin(terminal, 0, 1000, new AbortController().signal)).toBe(true)
    vi.spyOn(terminal, 'changed').mockRejectedValueOnce(new Error('wait failed'))
    await expect(changedWithin(terminal, terminal.revision, 1000, new AbortController().signal)).rejects.toThrow('wait failed')
    const stop = new AbortController()
    const waiting = changedWithin(terminal, terminal.revision, 1000, stop.signal)
    stop.abort()
    expect(await waiting).toBe(false)
  })
})
