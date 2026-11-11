/** Opening sidebar terminals for the registry: policy, launch request, startup readiness and cleanup. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentTerminalError } from '@deepseek-ai/dsh-api-terminal-controller'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { brandString } from '@deepseek-ai/dsh-brand'
import { TerminalBackendCleanupError, type TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import { Config } from '../src/config.ts'
import { PanelTerminalBackend, SUBAGENT_REFUSAL, startup } from '../src/backend.ts'
import { POLICY_CHANGED } from '../src/session.ts'
import type { PanelBackendServices } from '../src/backend.ts'
import { agentFor } from './agent.ts'
import { FakeTerminal, SHELL_PID } from './fake.ts'

const config = Config({ startupSilenceMs: 300, startupTimeoutMs: 5000, probeIntervalMs: 1000, preferredShells: ['zsh'] })
const policy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: '/workspace' }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) })
afterEach(() => { vi.useRealTimers() })

function backend(terminal = new FakeTerminal()) {
  const services = {
    open: vi.fn<PanelBackendServices['open']>(async () => terminal),
    policy: vi.fn<PanelBackendServices['policy']>(() => policy),
  }
  return { terminal, services, backend: new PanelTerminalBackend(services, config) }
}

describe('spawn', () => {
  it('opens the terminal under the Session policy and returns it after the shell reaches its prompt', async () => {
    const { terminal, services, backend: panel } = backend()
    const owner = agentFor(new Context(), 'session')
    const spawning = panel.spawn({ sessionId: brandString<TerminalSessionId>('pty-1'), owner, type: 'shell', name: 'dev server', cwd: '/workspace/app' })
    await vi.advanceTimersByTimeAsync(50)
    terminal.output('%')
    await vi.advanceTimersByTimeAsync(300)
    const session = await spawning
    expect(panel.type).toBe('shell')
    expect(services.policy).toHaveBeenCalledWith(owner.session)
    expect(services.open).toHaveBeenCalledWith(owner, {
      title: 'dev server', cwd: '/workspace/app', cols: 160, rows: 40, policy, preferredShells: ['zsh'], env: { PAGER: 'cat', GIT_PAGER: 'cat' },
    }, expect.any(AbortSignal))
    expect(session.motd).toBe('$%')
    expect(session.pid).toBe(SHELL_PID)
  })

  it('checks each send against the policy the Session resolves at that moment', async () => {
    const { terminal, services, backend: panel } = backend()
    const owner = agentFor(new Context(), 'session')
    const spawning = panel.spawn({ sessionId: brandString<TerminalSessionId>('pty-1'), owner, type: 'shell' })
    await vi.advanceTimersByTimeAsync(300)
    const session = await spawning
    services.policy.mockReturnValue({ ...policy, mode: 'read-only' })
    expect(() => session.startSend({ text: 'ls', submit: true })).toThrow(POLICY_CHANGED)
    expect(services.policy).toHaveBeenLastCalledWith(owner.session)
    expect(terminal.write).not.toHaveBeenCalled()
  })

  it('titles an unnamed terminal with its registry id and leaves the directory to the controller', async () => {
    const { terminal, services, backend: panel } = backend()
    const spawning = panel.spawn({ sessionId: brandString<TerminalSessionId>('pty-2'), owner: agentFor(new Context(), 'session'), type: 'shell' })
    await vi.advanceTimersByTimeAsync(0)
    terminal.output('$ ')
    await vi.advanceTimersByTimeAsync(300)
    await spawning
    expect(services.open.mock.calls[0]?.[1]).not.toHaveProperty('cwd')
    expect(services.open.mock.calls[0]?.[1]).toMatchObject({ title: 'pty-2' })
  })

  it('refuses subagents before opening anything', async () => {
    const { services, backend: panel } = backend()
    await expect(panel.spawn({ sessionId: brandString<TerminalSessionId>('pty-1'), owner: agentFor(new Context(), 'child', { subagent: true }), type: 'shell' }))
      .rejects.toThrow(SUBAGENT_REFUSAL)
    expect(services.open).not.toHaveBeenCalled()
  })

  it('closes the terminal when startup fails and reports a failed cleanup with the cause', async () => {
    const failed = backend()
    failed.terminal.screen = ['']
    const spawning = failed.backend.spawn({ sessionId: brandString<TerminalSessionId>('pty-1'), owner: agentFor(new Context(), 'session'), type: 'shell' })
    const rejected = expect(spawning).rejects.toThrow('did not reach its prompt within 5000 ms')
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(failed.terminal.close).toHaveBeenCalledOnce()

    const stuck = backend()
    stuck.terminal.close.mockRejectedValueOnce(new Error('cleanup failed'))
    const abort = new AbortController()
    const cancelled = stuck.backend.spawn({ sessionId: brandString<TerminalSessionId>('pty-1'), owner: agentFor(new Context(), 'session'), type: 'shell', signal: abort.signal })
    await vi.advanceTimersByTimeAsync(0)
    abort.abort(new Error('tool call cancelled'))
    const error = await cancelled.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(TerminalBackendCleanupError)
    expect(error).toMatchObject({ spawnError: new Error('tool call cancelled'), cleanupError: new Error('cleanup failed') })
  })

  it('leaves a terminal the person took over during startup open', async () => {
    const { terminal, backend: panel } = backend()
    terminal.close.mockRejectedValueOnce(new AgentTerminalError('user-control', 'The user has taken over this terminal'))
    const spawning = panel.spawn({ sessionId: brandString<TerminalSessionId>('pty-1'), owner: agentFor(new Context(), 'session'), type: 'shell' })
    const rejected = expect(spawning).rejects.toThrow('exited during startup')
    await vi.advanceTimersByTimeAsync(0)
    terminal.update({ state: 'exited', exitCode: 1 })
    await rejected
    expect(terminal.close).toHaveBeenCalledOnce()
  })

  it('rejects an already cancelled request', async () => {
    const { services, backend: panel } = backend()
    await expect(panel.spawn({ sessionId: brandString<TerminalSessionId>('pty-1'), owner: agentFor(new Context(), 'session'), type: 'shell', signal: AbortSignal.abort(new Error('gone')) }))
      .rejects.toThrow('gone')
    expect(services.open).not.toHaveBeenCalled()
  })
})

describe('startup', () => {
  const options = { startupSilenceMs: 300, startupTimeoutMs: 10_000, probeIntervalMs: 1000, maxReadBytes: 1000 }

  it('keeps waiting while a startup file runs a quiet program and output restarts the silence', async () => {
    const terminal = new FakeTerminal()
    terminal.foreground = { processGroupId: 400, inputWaiting: false }
    const ready = startup(terminal, options, new AbortController().signal)
    let motd: string | undefined
    void ready.then((value) => { motd = value })
    terminal.output('loading nvm')
    await vi.advanceTimersByTimeAsync(1500)
    expect(motd).toBeUndefined()
    expect(terminal.inspectForeground).toHaveBeenCalledTimes(2)
    terminal.inspectForeground.mockImplementationOnce(async () => {
      terminal.output('', '$')
      return { processGroupId: SHELL_PID, inputWaiting: false }
    })
    await vi.advanceTimersByTimeAsync(800)
    expect(motd).toBeUndefined()
    terminal.foreground = { processGroupId: 500, inputWaiting: true }
    await vi.advanceTimersByTimeAsync(1000)
    expect(motd).toBe('$loading nvm\n$')
  })

  it('counts a prompt printed before startup began as output', async () => {
    const terminal = new FakeTerminal()
    const ready = startup(terminal, options, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(300)
    expect(await ready).toBe('$')
    expect(terminal.inspectForeground).toHaveBeenCalledOnce()
  })

  it('waits for output on an empty screen even when attachment state advances the revision', async () => {
    const terminal = new FakeTerminal()
    terminal.screen = ['']
    terminal.update({ cols: 120 })
    const ready = startup(terminal, options, new AbortController().signal)
    let motd: string | undefined
    void ready.then((value) => { motd = value })
    await vi.advanceTimersByTimeAsync(2000)
    expect(motd).toBeUndefined()
    expect(terminal.inspectForeground).not.toHaveBeenCalled()
    terminal.output('$')
    await vi.advanceTimersByTimeAsync(300)
    expect(motd).toBe('$')
  })

  it('accepts silence alone when the foreground cannot be observed', async () => {
    const terminal = new FakeTerminal()
    terminal.foreground = undefined
    const ready = startup(terminal, options, new AbortController().signal)
    terminal.output(' ready')
    await vi.advanceTimersByTimeAsync(300)
    expect(await ready).toBe('$ ready')
  })
})
