/** Session identity, allocation races, confinement and real PTY behavior. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SubprocessExecutableNotFoundError, type SubprocessRuntime, type SubprocessTerminalEnvironment, type SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalController, type Config } from '../src/index.ts'
import { resolveShell } from '../src/shells.ts'
import type { TerminalAttachmentId, WebTerminalId } from '../src/types.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const config: Config = { shellCandidates: ['zsh', 'bash', 'sh'], shell: { path: '/bin/bash', name: 'bash', args: ['--noprofile', '--norc', '-i'] }, maxTerminals: 2, maxCols: 200, maxRows: 100, scrollback: 100, maxBufferedBytes: 100_000, maxInputBytes: 1000, disposeGraceMs: 100, unattendedTimeoutMs: 7_200_000, activityPollIntervalMs: 30_000, cleanupRetryMs: 60_000 }
const id = 'test-terminal' as WebTerminalId
const request = { id, cols: 80, rows: 24 }
const signal = (): AbortSignal => new AbortController().signal

function owner(ctx: Context, id = 'session'): Agent {
  return { id: id as SessionId, ctx, session: { id: id as SessionId } } as unknown as Agent
}

function fixture(overrides: Partial<Config> = {}) {
  const ctx = new Context()
  roots.push(ctx)
  const effects = vi.spyOn(ctx.fiber, 'effect')
  const sandboxPolicy = { defaultMode: 'danger-full-access', resolve: vi.fn((): SandboxExecutionPolicy => ({ mode: 'danger-full-access', workspaceRoot: '/workspace' })) }
  const projections = { stateOf: vi.fn((): SandboxMode | null => null) }
  ctx.provide('sandboxPolicy', sandboxPolicy as never)
  ctx.provide('sessionProjections', projections as never)
  const output = new PassThrough()
  const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
  const handle = {
    pid: 123, output, done: done.promise, write: vi.fn(async () => {}), resize: vi.fn(async () => {}),
    inspectActivity: vi.fn<SubprocessTerminalHandle['inspectActivity']>(async () => ({ state: 'unknown', revision: 0 })),
    inspectForeground: async () => undefined, signalForeground: async () => 123,
    terminate: vi.fn(async () => { output.end(); done.resolve({ exitCode: 0, signal: null }) }) }
  const checked: SubprocessTerminalHandle = handle
  const subprocess = { terminalEnvironment: vi.fn(async (): Promise<SubprocessTerminalEnvironment> => ({ platform: 'posix', defaultShell: '/bin/bash' })), resolveExecutable: vi.fn(async (path: string) => path), spawnTerminal: vi.fn(async () => checked) }
  ctx.provide('subprocess', subprocess as never)
  const controller = new TerminalController(ctx, { ...config, ...overrides })
  const disposeEffect = (label: string): Promise<void> => {
    const index = effects.mock.calls.findIndex(call => call[1] === label)
    const result = effects.mock.results[index]
    if (result?.type !== 'return' || typeof result.value !== 'function') throw new Error(`Missing effect: ${label}`)
    return result.value()
  }
  return { ctx, agent: owner(ctx), controller, subprocess, handle, sandboxPolicy, projections, disposeEffect }
}

describe('TerminalController', () => {
  it('resolves execution services from an Agent plugin context without consumer injections', async () => {
    const { ctx, controller } = fixture()
    let agent: Agent | undefined
    await ctx.plugin((child) => { agent = owner(child) })
    if (agent === undefined) throw new Error('Agent plugin did not load')
    expect(controller.environment(agent, signal())).toMatchObject({ cwd: '/workspace' })
    await controller.create(agent, request, signal())
    await controller.close(agent, id)
  })

  it('creates the environment default shell and keeps an existing identity when that default changes', async () => {
    const { controller, agent, subprocess } = fixture({ shell: undefined })
    subprocess.terminalEnvironment.mockResolvedValue({ platform: 'posix', defaultShell: '/usr/local/bin/zsh' })
    expect(controller.environment(agent, signal())).toEqual({ cwd: '/workspace', maxCols: 200, maxRows: 100, maxInputBytes: 1000, scrollback: 100 })
    expect(subprocess.terminalEnvironment).not.toHaveBeenCalled()
    const created = await controller.create(agent, request, signal())
    expect(created.shell.path).toBe('/usr/local/bin/zsh')
    expect(subprocess.spawnTerminal).toHaveBeenCalledWith(expect.objectContaining({ argv: ['/usr/local/bin/zsh', '-i'] }))
    subprocess.terminalEnvironment.mockResolvedValue({ platform: 'posix', defaultShell: '/bin/sh' })
    expect(await controller.create(agent, request, signal())).toBe(created)
    expect(subprocess.terminalEnvironment).toHaveBeenCalledOnce()
    expect(subprocess.spawnTerminal).toHaveBeenCalledOnce()
  })

  it('restores a running terminal after its default executable becomes unavailable', async () => {
    const { controller, agent, subprocess } = fixture({ shell: undefined })
    await controller.create(agent, request, signal())
    subprocess.resolveExecutable.mockRejectedValue(new SubprocessExecutableNotFoundError('default shell was removed'))
    expect(controller.environment(agent, signal())).toMatchObject({ cwd: '/workspace', maxInputBytes: 1000 })
    expect(controller.list(agent.id)).toMatchObject([{ id, state: 'running' }])
    const stream = controller.follow(agent, id, 'restored' as TerminalAttachmentId, signal())[Symbol.asyncIterator]()
    try {
      expect(await stream.next()).toMatchObject({ done: false, value: { type: 'snapshot', info: { id, state: 'running' } } })
      expect(subprocess.resolveExecutable).toHaveBeenCalledOnce()
      await expect(controller.create(agent, { ...request, id: 'new-terminal' as WebTerminalId }, signal())).rejects.toThrow('default shell was removed')
      expect(subprocess.spawnTerminal).toHaveBeenCalledOnce()
    } finally { await stream.return?.() }
  })

  it('honors cancellation before reading environment limits', () => {
    const { controller, agent, subprocess, sandboxPolicy } = fixture()
    const abort = new AbortController()
    abort.abort(new Error('request cancelled'))
    expect(() => controller.environment(agent, abort.signal)).toThrow('request cancelled')
    expect(subprocess.terminalEnvironment).not.toHaveBeenCalled()
    expect(sandboxPolicy.resolve).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent creates, scopes access by Session, and preserves terminals when a stream aborts', async () => {
    const { controller, agent, ctx, subprocess, handle } = fixture()
    const [first, second] = await Promise.all([controller.create(agent, request, signal()), controller.create(agent, request, signal())])
    expect(first.id).toBe(second.id)
    expect(subprocess.spawnTerminal).toHaveBeenCalledOnce()
    expect(subprocess.spawnTerminal).toHaveBeenCalledWith(expect.objectContaining({ terminalType: 'xterm-256color', cwd: '/workspace' }))
    expect(controller.list('other' as SessionId)).toEqual([])
    expect(() => controller.follow(owner(ctx, 'other'), id, 'writer' as TerminalAttachmentId, signal())).toThrow('no longer exists')
    const abort = new AbortController()
    const stream = controller.follow(agent, id, 'writer' as TerminalAttachmentId, abort.signal)[Symbol.asyncIterator]()
    const firstFrame = await stream.next()
    if (firstFrame.done === true) throw new Error('Terminal stream ended before its snapshot')
    expect(firstFrame.value.type).toBe('snapshot')
    abort.abort()
    await stream.return?.()
    expect(handle.terminate).not.toHaveBeenCalled()
    await controller.close(agent, id)
    expect(handle.terminate).toHaveBeenCalledOnce()
    expect(controller.list(agent.id)).toEqual([])
    await controller.close(agent, id)
  })

  it('waits for pending allocation when explicitly closing and rolls back cancellation before publication', async () => {
    const { controller, agent, subprocess, handle } = fixture()
    const allocation = Promise.withResolvers<SubprocessTerminalHandle>()
    subprocess.spawnTerminal.mockImplementationOnce(() => allocation.promise)
    const creating = controller.create(agent, request, signal())
    const rejected = expect(creating).rejects.toThrow('closed in this Session')
    const closing = controller.close(agent, id)
    allocation.resolve(handle)
    await rejected
    await closing
    expect(controller.list(agent.id)).toEqual([])
    expect(handle.terminate).toHaveBeenCalledOnce()
  })

  it('rejects a delayed create after close even when that identity has never been allocated', async () => {
    const { controller, agent, subprocess } = fixture()
    await controller.close(agent, id)
    await controller.close(agent, id)
    await expect(controller.create(agent, request, signal())).rejects.toThrow('closed in this Session')
    expect(subprocess.spawnTerminal).not.toHaveBeenCalled()
    const nextId = 'next-terminal' as WebTerminalId
    await expect(controller.create(agent, { ...request, id: nextId }, signal())).resolves.toMatchObject({ id: nextId })
    expect(subprocess.spawnTerminal).toHaveBeenCalledOnce()
  })

  it('rejects original, duplicate and later creates when close arrives during allocation', async () => {
    const { controller, agent, subprocess, handle } = fixture()
    const allocation = Promise.withResolvers<SubprocessTerminalHandle>()
    const spawning = Promise.withResolvers<undefined>()
    subprocess.spawnTerminal.mockImplementationOnce(() => { spawning.resolve(undefined); return allocation.promise })
    const creating = controller.create(agent, request, signal())
    const duplicate = controller.create(agent, request, signal())
    const rejected = expect(creating).rejects.toThrow('closed in this Session')
    const duplicateRejected = expect(duplicate).rejects.toThrow('closed in this Session')
    try {
      await spawning.promise
      const closing = controller.close(agent, id)
      await expect(controller.create(agent, request, signal())).rejects.toThrow('closed in this Session')
      allocation.resolve(handle)
      await Promise.all([rejected, duplicateRejected, closing])
      await expect(controller.create(agent, request, signal())).rejects.toThrow('closed in this Session')
      expect(handle.terminate).toHaveBeenCalledOnce()
      expect(subprocess.spawnTerminal).toHaveBeenCalledOnce()
      expect(controller.list(agent.id)).toEqual([])
    } finally { allocation.resolve(handle) }
  })

  it('retains failed allocation cleanup for a later explicit close', async () => {
    const { controller, agent, subprocess, handle } = fixture()
    const abort = new AbortController()
    subprocess.spawnTerminal.mockImplementationOnce(async () => { abort.abort(new Error('request disconnected')); return handle })
    vi.mocked(handle.terminate).mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(controller.create(agent, request, abort.signal)).rejects.toThrow('cleanup failed')
    expect(controller.list(agent.id)).toMatchObject([{ id, state: 'failed' }])
    await controller.close(agent, id)
    expect(handle.terminate).toHaveBeenCalledTimes(2)
    expect(controller.list(agent.id)).toEqual([])
  })

  it('retains a terminal when process cleanup fails so closing can be retried', async () => {
    const { controller, agent, handle } = fixture()
    await controller.create(agent, request, signal())
    vi.mocked(handle.terminate).mockRejectedValueOnce(new Error('process still alive'))
    await expect(controller.close(agent, id)).rejects.toThrow('still alive')
    expect(controller.list(agent.id)).toHaveLength(1)
    await expect(controller.create(agent, request, signal())).rejects.toThrow('closed in this Session')
    await controller.close(agent, id)
    expect(controller.list(agent.id)).toHaveLength(0)
  })

  it('rejects invalid dimensions, unavailable shells and oversized input before executing them', async () => {
    const { controller, agent, subprocess } = fixture()
    await expect(controller.create(agent, { ...request, cols: 1 }, signal())).rejects.toThrow('dimensions')
    subprocess.resolveExecutable.mockRejectedValueOnce(new SubprocessExecutableNotFoundError('shell unavailable'))
    await expect(controller.create(agent, request, signal())).rejects.toThrow('unavailable')
    expect(subprocess.spawnTerminal).not.toHaveBeenCalled()
    await expect(controller.write(agent, id, 'writer' as TerminalAttachmentId, 'x'.repeat(1001))).rejects.toThrow('input')
  })

  it('keeps the committed identity on repeated creation and counts pending reservations toward the Session limit', async () => {
    const { controller, agent, subprocess, handle } = fixture({ maxTerminals: 1 })
    const allocation = Promise.withResolvers<SubprocessTerminalHandle>()
    const spawning = Promise.withResolvers<undefined>()
    subprocess.spawnTerminal.mockImplementationOnce(() => { spawning.resolve(undefined); return allocation.promise })
    const creating = controller.create(agent, request, signal())
    try {
      await spawning.promise
      await expect(controller.create(agent, { ...request, id: 'another' as WebTerminalId }, signal())).rejects.toMatchObject({ code: 'terminal/limit-reached', details: { limit: 1 } })
    } finally { allocation.resolve(handle) }
    const first = await creating
    expect(await controller.create(agent, request, signal())).toBe(first)
    expect(subprocess.spawnTerminal).toHaveBeenCalledOnce()
  })

  it('keeps failed allocations reserved until their cleanup succeeds', async () => {
    const { controller, agent, subprocess, handle } = fixture({ maxTerminals: 1 })
    const abort = new AbortController()
    subprocess.spawnTerminal.mockImplementationOnce(async () => { abort.abort('lost request'); return handle })
    handle.terminate.mockRejectedValueOnce(new Error('still alive'))
    await expect(controller.create(agent, request, abort.signal)).rejects.toThrow('cleanup failed')
    expect(controller.list(agent.id)).toMatchObject([{ id, state: 'failed', error: 'lost request' }])
    await expect(controller.create(agent, request, signal())).rejects.toThrow('closed in this Session')
    await expect(controller.create(agent, { ...request, id: 'another' as WebTerminalId }, signal())).rejects.toMatchObject({ code: 'terminal/limit-reached', details: { limit: 1 } })
    await controller.close(agent, id)
    expect(controller.list(agent.id)).toEqual([])
  })

  it('lets close reclaim an allocation whose request failed while close was waiting', async () => {
    const { controller, agent, subprocess, handle } = fixture()
    const allocation = Promise.withResolvers<SubprocessTerminalHandle>()
    const abort = new AbortController()
    subprocess.spawnTerminal.mockImplementationOnce(() => allocation.promise)
    const creating = controller.create(agent, request, abort.signal)
    const rejected = expect(creating).rejects.toThrow('cancelled')
    const closing = controller.close(agent, id)
    abort.abort(new Error('cancelled'))
    allocation.resolve(handle)
    await rejected
    await closing
    expect(handle.terminate).toHaveBeenCalledOnce()
    expect(controller.list(agent.id)).toEqual([])
  })

  it('routes input, resize and trimmed names through the active attachment', async () => {
    const { controller, agent, handle } = fixture({ maxInputBytes: 6 })
    await controller.create(agent, request, signal())
    const attachmentId = 'writer' as TerminalAttachmentId
    const stream = controller.follow(agent, id, attachmentId, signal())[Symbol.asyncIterator]()
    await stream.next()
    try {
      await controller.write(agent, id, attachmentId, '终端')
      expect(handle.write).toHaveBeenCalledWith('终端')
      await expect(controller.write(agent, id, attachmentId, '终端!')).rejects.toThrow('input exceeds')
      await controller.resize(agent, id, attachmentId, 200, 100)
      expect(handle.resize).toHaveBeenCalledWith(200, 100)
      controller.rename(agent, id, '  server logs  ')
      expect(controller.list(agent.id)).toMatchObject([{ title: 'server logs', cols: 200, rows: 100 }])
    } finally { await stream.return?.() }
  })

  it.each([{ cols: 1.5, rows: 24 }, { cols: 201, rows: 24 }, { cols: 80, rows: 1.5 }, { cols: 80, rows: 0 }, { cols: 80, rows: 101 }])('rejects dimensions $cols × $rows before allocation or resize', async (dimensions) => {
    const { controller, agent, subprocess, handle } = fixture()
    await expect(controller.create(agent, { ...request, ...dimensions }, signal())).rejects.toThrow('dimensions')
    await expect(controller.resize(agent, id, 'writer' as TerminalAttachmentId, dimensions.cols, dimensions.rows)).rejects.toThrow('dimensions')
    expect(subprocess.spawnTerminal).not.toHaveBeenCalled()
    expect(handle.resize).not.toHaveBeenCalled()
  })

  it('rejects invalid wire identities and names without changing retained terminals', async () => {
    const { controller, agent } = fixture()
    await expect(controller.create(agent, { ...request, id: '../terminal' as WebTerminalId }, signal())).rejects.toThrow('Invalid terminal identity')
    expect(() => controller.follow(agent, id, '' as TerminalAttachmentId, signal())).toThrow('attachment identity')
    expect(() => { controller.rename(agent, id, '  ') }).toThrow('1–120')
    expect(() => { controller.rename(agent, id, 'x'.repeat(121)) }).toThrow('1–120')
    await controller.close(agent, id)
    expect(controller.list(agent.id)).toEqual([])
  })

  it('uses the Session sandbox policy to confine its selected shell', async () => {
    const { controller, agent, ctx, sandboxPolicy, subprocess } = fixture()
    const policy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: '/workspace', sessionId: agent.id }
    sandboxPolicy.resolve.mockReturnValue(policy)
    const confine = vi.fn((argv: readonly string[]) => ({ argv: ['sandbox-runner', ...argv] }))
    ctx.provide('sandbox', { confine } as never)
    await controller.create(agent, request, signal())
    expect(confine).toHaveBeenCalledWith(['/bin/bash', '--noprofile', '--norc', '-i'], policy, expect.any(AbortSignal))
    expect(subprocess.spawnTerminal).toHaveBeenCalledWith(expect.objectContaining({ argv: ['sandbox-runner', '/bin/bash', '--noprofile', '--norc', '-i'], env: { DSH_SESSION_ID: agent.id }, graceMs: 100 }))
  })

  it('rejects a confined Session without a sandbox provider before spawning', async () => {
    const { controller, agent, sandboxPolicy, subprocess } = fixture()
    sandboxPolicy.resolve.mockReturnValue({ mode: 'read-only', workspaceRoot: '/workspace' })
    await expect(controller.create(agent, request, signal())).rejects.toThrow('requires an execution sandbox provider')
    expect(subprocess.spawnTerminal).not.toHaveBeenCalled()
  })

  it.each(['subprocess', 'sandboxPolicy'] as const)('fails clearly when the Session lacks %s', (missing) => {
    const { controller, subprocess, sandboxPolicy } = fixture()
    const isolated = new Context()
    roots.push(isolated)
    if (missing !== 'subprocess') isolated.provide('subprocess', subprocess as never)
    if (missing !== 'sandboxPolicy') isolated.provide('sandboxPolicy', sandboxPolicy as never)
    expect(() => controller.environment(owner(isolated), signal())).toThrow('requires subprocess and sandbox policy providers')
  })

  it('blocks sandbox-mode changes only while that Session retains a terminal', async () => {
    const { controller, agent, ctx, projections } = fixture()
    const mode = (mode: SandboxMode): void => { ctx.emit('session/event', agent.session, { type: 'sandbox/mode', data: { mode } } as SessionEvent) }
    ctx.emit('session/disposed', agent.session)
    ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } } as SessionEvent)
    expect(() => { mode('workspace-write') }).not.toThrow()
    await controller.create(agent, request, signal())
    expect(() => { mode('danger-full-access') }).not.toThrow()
    expect(() => { mode('workspace-write') }).toThrow('Close browser terminals')
    projections.stateOf.mockReturnValue('read-only')
    expect(() => { mode('read-only') }).not.toThrow()
    expect(() => { mode('danger-full-access') }).toThrow('Close browser terminals')
    await controller.close(agent, id)
    expect(() => { mode('workspace-write') }).not.toThrow()
  })

  it('terminates committed processes when the Session effect ends', async () => {
    const { controller, agent, handle, disposeEffect } = fixture()
    await controller.create(agent, request, signal())
    await disposeEffect('terminal-controller.owner')
    expect(handle.terminate).toHaveBeenCalledOnce()
    expect(controller.list(agent.id)).toEqual([])
  })

  it('cleans up a Session when its real Agent plugin fiber is disposed', async () => {
    const { controller, ctx, handle } = fixture()
    let agent: Agent | undefined
    const fiber = await ctx.plugin((child) => { agent = owner(child) })
    if (agent === undefined) throw new Error('Agent plugin did not load')
    await controller.create(agent, request, signal())
    await fiber.dispose()
    expect(handle.terminate).toHaveBeenCalledOnce()
    expect(controller.list(agent.id)).toEqual([])
  })

  it('waits for pending creation during Host disposal and rolls back its process before resolving', async () => {
    const { controller, agent, subprocess, handle, disposeEffect } = fixture()
    const allocation = Promise.withResolvers<SubprocessTerminalHandle>()
    const spawning = Promise.withResolvers<undefined>()
    subprocess.spawnTerminal.mockImplementationOnce(() => { spawning.resolve(undefined); return allocation.promise })
    const creating = controller.create(agent, request, signal())
    const rejected = expect(creating).rejects.toThrow('disposed')
    await spawning.promise
    const disposing = disposeEffect('terminal-controller.processes')
    allocation.resolve(handle)
    await rejected
    await disposing
    expect(handle.terminate).toHaveBeenCalledOnce()
    expect(controller.list(agent.id)).toEqual([])
    await expect(controller.create(agent, request, signal())).rejects.toThrow('controller disposed')
  })

  it('shares cleanup between the Session and Host effects while awaiting process termination', async () => {
    const { controller, agent, handle, disposeEffect } = fixture()
    await controller.create(agent, request, signal())
    const stopping = Promise.withResolvers<undefined>()
    const stopped = Promise.withResolvers<undefined>()
    const terminate = handle.terminate.getMockImplementation()
    if (terminate === undefined) throw new Error('Missing process cleanup fixture')
    handle.terminate.mockImplementationOnce(async () => { stopping.resolve(undefined); await stopped.promise; await terminate() })
    const ownerDisposal = disposeEffect('terminal-controller.owner')
    try {
      await stopping.promise
      const hostDisposal = disposeEffect('terminal-controller.processes')
      stopped.resolve(undefined)
      await Promise.all([ownerDisposal, hostDisposal])
      expect(handle.terminate).toHaveBeenCalledOnce()
      expect(controller.list(agent.id)).toEqual([])
    } finally { stopped.resolve(undefined) }
  })

  it('retains cleanup failures from both Session and Host disposal for explicit retry', async () => {
    const { controller, agent, handle, disposeEffect } = fixture()
    await controller.create(agent, request, signal())
    handle.terminate.mockRejectedValueOnce(new Error('still alive'))
    await expect(disposeEffect('terminal-controller.owner')).rejects.toThrow('Session terminal cleanup failed')
    await expect(controller.create(agent, request, signal())).rejects.toThrow('Session owner disposed')
    handle.terminate.mockRejectedValueOnce(new Error('still alive again'))
    await expect(disposeEffect('terminal-controller.processes')).rejects.toThrow('Browser terminal cleanup failed')
    expect(controller.list(agent.id)).toHaveLength(1)
    await controller.close(agent, id)
    expect(controller.list(agent.id)).toEqual([])
    expect(handle.terminate).toHaveBeenCalledTimes(3)
  })

  it('reclaims retained failed allocations when the owning Session ends', async () => {
    const { controller, agent, subprocess, handle, disposeEffect } = fixture()
    const abort = new AbortController()
    subprocess.spawnTerminal.mockImplementationOnce(async () => { abort.abort(new Error('disconnected')); return handle })
    handle.terminate.mockRejectedValueOnce(new Error('first cleanup failed'))
    await expect(controller.create(agent, request, abort.signal)).rejects.toThrow('cleanup failed')
    await disposeEffect('terminal-controller.owner')
    expect(handle.terminate).toHaveBeenCalledTimes(2)
    expect(controller.list(agent.id)).toEqual([])
  })
})

describe('shell resolution', () => {
  it('accepts an omitted shell profile and defaults configured arguments to an empty list', () => {
    // Loader input is unvalidated; the schema's declared type describes its normalized output.
    const parse = (input: unknown): Config => TerminalController.Config(input as Config)
    expect(parse({}).shell).toBeUndefined()
    expect(parse({})).toMatchObject({ unattendedTimeoutMs: 7_200_000, activityPollIntervalMs: 30_000, cleanupRetryMs: 60_000 })
    expect(parse({ unattendedTimeoutMs: 0 }).unattendedTimeoutMs).toBe(0)
    for (const key of ['unattendedTimeoutMs', 'activityPollIntervalMs', 'cleanupRetryMs']) {
      for (const value of [-1, 0.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => parse({ [key]: value })).toThrow()
      }
    }
    for (const key of ['activityPollIntervalMs', 'cleanupRetryMs']) expect(() => parse({ [key]: 0 })).toThrow()
    expect(parse({ shell: { path: 'custom', name: 'Project shell' } }).shell).toEqual({ path: 'custom', name: 'Project shell', args: [] })
    expect(() => parse({ shell: { name: 'Project shell' } })).toThrow()
  })

  it.each([
    { platform: 'posix' as const, path: '/bin/sh', name: 'sh', args: ['-i'] },
    { platform: 'windows' as const, path: 'cmd.exe', name: 'cmd.exe', args: [] },
  ])('uses the conservative $platform fallback only when the provider omits its default shell', async ({ platform, path, name, args }) => {
    const { subprocess } = fixture()
    subprocess.terminalEnvironment.mockResolvedValue({ platform })
    const runtime = subprocess as unknown as SubprocessRuntime
    const requestSignal = signal()
    expect(await resolveShell(runtime, undefined, requestSignal)).toEqual({ path, name, args })
    expect(subprocess.resolveExecutable).toHaveBeenCalledExactlyOnceWith(path, undefined, requestSignal)
  })

  it.each([
    { platform: 'posix' as const, defaultShell: '/usr/local/bin/fish', name: 'fish', args: ['-i'] },
    { platform: 'windows' as const, defaultShell: 'C:\\Windows\\CMD.EXE', name: 'CMD.EXE', args: [] },
    { platform: 'windows' as const, defaultShell: 'C:\\PowerShell\\powershell.exe', name: 'powershell.exe', args: ['-NoLogo'] },
    { platform: 'posix' as const, defaultShell: '/usr/local/bin/pwsh', name: 'pwsh', args: ['-NoLogo'] },
  ])('resolves only the declared default $defaultShell with its interactive arguments', async ({ platform, defaultShell, name, args }) => {
    const { subprocess } = fixture()
    subprocess.terminalEnvironment.mockResolvedValue({ platform, defaultShell })
    subprocess.resolveExecutable.mockResolvedValue('/resolved/shell')
    const runtime = subprocess as unknown as SubprocessRuntime
    const requestSignal = signal()
    expect(await resolveShell(runtime, undefined, requestSignal)).toEqual({ path: '/resolved/shell', name, args })
    expect(subprocess.terminalEnvironment).toHaveBeenCalledExactlyOnceWith(requestSignal)
    expect(subprocess.resolveExecutable).toHaveBeenCalledExactlyOnceWith(defaultShell, undefined, requestSignal)
  })

  it('uses an explicit profile without querying the environment and preserves its name and arguments', async () => {
    const { subprocess } = fixture()
    subprocess.resolveExecutable.mockResolvedValue('/resolved/custom')
    const runtime = subprocess as unknown as SubprocessRuntime
    const requestSignal = signal()
    const configured = { path: 'custom', name: 'Project shell', args: ['--project'] }
    expect(await resolveShell(runtime, configured, requestSignal)).toEqual({ ...configured, path: '/resolved/custom' })
    expect(subprocess.terminalEnvironment).not.toHaveBeenCalled()
    expect(subprocess.resolveExecutable).toHaveBeenCalledExactlyOnceWith('custom', undefined, requestSignal)
  })

  it.each([new SubprocessExecutableNotFoundError('missing default'), new Error('transport unavailable')])('reports default resolution failure without attempting fallback: %s', async (failure) => {
    const { subprocess } = fixture()
    subprocess.resolveExecutable.mockRejectedValue(failure)
    const runtime = subprocess as unknown as SubprocessRuntime
    await expect(resolveShell(runtime, undefined, signal())).rejects.toBe(failure)
    expect(subprocess.resolveExecutable).toHaveBeenCalledOnce()
  })

  it('reports an unavailable configured shell without consulting the provider default', async () => {
    const { subprocess } = fixture()
    const failure = new SubprocessExecutableNotFoundError('missing configured shell')
    subprocess.resolveExecutable.mockRejectedValue(failure)
    const runtime = subprocess as unknown as SubprocessRuntime
    await expect(resolveShell(runtime, { path: '/missing', name: 'missing', args: [] }, signal())).rejects.toBe(failure)
    expect(subprocess.resolveExecutable).toHaveBeenCalledOnce()
    expect(subprocess.terminalEnvironment).not.toHaveBeenCalled()
  })

  it('propagates environment cancellation before verifying an executable', async () => {
    const { subprocess } = fixture()
    const cancelled = new Error('request disconnected')
    subprocess.terminalEnvironment.mockRejectedValue(cancelled)
    const runtime = subprocess as unknown as SubprocessRuntime
    await expect(resolveShell(runtime, undefined, signal())).rejects.toBe(cancelled)
    expect(subprocess.resolveExecutable).not.toHaveBeenCalled()
  })
})

it.skipIf(process.platform === 'win32')('runs a real interactive shell with completion, TERM and live window dimensions', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-web-terminal-'))
  const ctx = new Context()
  const runtime = await ctx.plugin(LocalSubprocessRuntime)
  try {
    const handle = await ctx.subprocess.spawnTerminal({ argv: ['/bin/bash', '--noprofile', '--norc', '-i'], cwd, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 100, env: { PS1: 'READY> ', PS2: '' } })
    let output = ''
    handle.output.on('data', (data: Buffer) => { output += data.toString('utf8') })
    try {
      await expect.poll(() => output).toContain('READY>')
      await handle.resize(100, 30)
      await handle.write("printf 'TERM:%s\\n' \"$TERM\"; stty size\r")
      await expect.poll(() => output).toContain('TERM:xterm-256color')
      await expect.poll(() => output).toContain('30 100')
      // Bash's builtin completion expands this unambiguous command before Enter.
      await handle.write('histor\t')
      await expect.poll(() => output).toContain('history')
    } finally { await handle.terminate() }
    await expect(handle.done).resolves.toBeDefined()
  } finally {
    await runtime.dispose()
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})

it('discovers installed shells once per path, preserves default arguments, and refuses unlisted paths', async () => {
  const h = fixture({ shellCandidates: ['bash', 'zsh', 'missing'] })
  h.subprocess.resolveExecutable.mockImplementation(async (path) => {
    if (path === 'missing') throw new SubprocessExecutableNotFoundError('absent')
    return path.startsWith('/') ? path : `/bin/${path}`
  })
  const shells = await h.controller.shells(h.agent, signal())
  expect(shells).toEqual([config.shell, { path: '/bin/zsh', name: 'zsh', args: ['-i'] }])
  expect(h.subprocess.spawnTerminal).not.toHaveBeenCalled()
  await expect(h.controller.create(h.agent, { ...request, shellPath: '/bin/unlisted' }, signal())).rejects.toThrow('Selected shell is not available')
  expect(h.subprocess.spawnTerminal).not.toHaveBeenCalled()
  const created = await h.controller.create(h.agent, { ...request, shellPath: '/bin/zsh' }, signal())
  expect(created.shell.path).toBe('/bin/zsh')
  expect(h.subprocess.spawnTerminal).toHaveBeenCalledWith(expect.objectContaining({ argv: ['/bin/zsh', '-i'] }))
  h.subprocess.resolveExecutable.mockRejectedValue(new Error('SSH disconnected'))
  await expect(h.controller.shells(h.agent, signal())).rejects.toThrow('SSH disconnected')
  expect(await h.controller.create(h.agent, { ...request, shellPath: '/bin/bash' }, signal())).toBe(created)
})

it('propagates optional-shell discovery transport errors and cancellation', async () => {
  const h = fixture({ shellCandidates: ['fish'] })
  h.subprocess.resolveExecutable.mockImplementation(async (path) => {
    if (path === 'fish') throw new Error('lookup transport failed')
    return path
  })
  await expect(h.controller.shells(h.agent, signal())).rejects.toThrow('lookup transport failed')
  const cancelled = AbortSignal.abort(new Error('cancelled discovery'))
  expect(() => h.controller.shells(h.agent, cancelled)).toThrow('cancelled discovery')
})

it('deduplicates Windows executable paths regardless of letter case', async () => {
  const h = fixture({ shell: { path: 'C:\\Windows\\cmd.exe', name: 'Command Prompt', args: [] }, shellCandidates: ['c:\\windows\\cmd.exe'] })
  expect(await h.controller.shells(h.agent, signal())).toEqual([{ path: 'C:\\Windows\\cmd.exe', name: 'Command Prompt', args: [] }])
})

it('retains a known terminal without Agent resolution and fences stream admission after explicit close', async () => {
  const h = fixture()
  await h.controller.create(h.agent, request, signal())
  const abort = new AbortController()
  const held = h.controller.retain(h.agent.id, id, abort.signal)[Symbol.asyncIterator]()
  expect(await held.next()).toMatchObject({ value: { type: 'retained' } })
  expect(h.subprocess.spawnTerminal).toHaveBeenCalledOnce()
  expect(() => h.controller.retain('missing-session' as SessionId, id, signal())).toThrow('unavailable')
  const ended = held.next()
  await h.controller.close(h.agent, id)
  expect(await ended).toMatchObject({ done: true })
  expect(() => h.controller.retain(h.agent.id, id, signal())).toThrow('unavailable')
  await expect(h.controller.create(h.agent, request, signal())).rejects.toThrow('closed in this Session')
})

it('reclaims confirmed idle processes and preserves closed identity exclusion after removing their screens', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const h = fixture({ unattendedTimeoutMs: 100, activityPollIntervalMs: 10 })
  try {
    h.handle.inspectActivity.mockResolvedValue({ state: 'busy', revision: 0 })
    await h.controller.create(h.agent, request, signal())
    await vi.advanceTimersByTimeAsync(500)
    expect(h.handle.terminate).not.toHaveBeenCalled()
    h.handle.inspectActivity.mockResolvedValue({ state: 'idle', revision: 1 })
    await vi.advanceTimersByTimeAsync(110)
    expect(h.handle.terminate).toHaveBeenCalledOnce()
    expect(h.controller.list(h.agent.id)).toEqual([])
    await expect(h.controller.create(h.agent, request, signal())).rejects.toThrow('closed in this Session')
    expect(h.subprocess.spawnTerminal).toHaveBeenCalledOnce()
  } finally {
    await h.ctx.fiber.dispose()
    vi.useRealTimers()
  }
})

it.each(['allocation', 'committed'] as const)('retains failed %s cleanup, reports scheduled failures, and releases resources after retry', async (phase) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const h = fixture({ unattendedTimeoutMs: 100, activityPollIntervalMs: 10, cleanupRetryMs: 20 })
  h.handle.terminate.mockRejectedValueOnce(new Error('still alive')).mockRejectedValueOnce(new Error('still alive again'))
  try {
    if (phase === 'allocation') {
      const abort = new AbortController()
      h.subprocess.spawnTerminal.mockImplementationOnce(async () => { abort.abort(new Error('disconnected during spawn')); return h.handle })
      await expect(h.controller.create(h.agent, request, abort.signal)).rejects.toThrow('cleanup failed')
    } else {
      h.handle.inspectActivity.mockResolvedValue({ state: 'idle', revision: 1 })
      await h.controller.create(h.agent, request, signal())
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(h.controller.list(h.agent.id)).toHaveLength(1)
    expect(() => h.controller.retain(h.agent.id, id, signal())).toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(20)
    expect(h.handle.terminate).toHaveBeenCalledTimes(2)
    expect(h.controller.list(h.agent.id)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(20)
    expect(h.handle.terminate).toHaveBeenCalledTimes(3)
    expect(h.controller.list(h.agent.id)).toEqual([])
  } finally {
    await h.ctx.fiber.dispose()
    vi.useRealTimers()
  }
})

it('classifies missing and closing terminal identities for localized recovery actions', async () => {
  const h = fixture()
  expect(() => h.controller.follow(h.agent, id, 'view' as TerminalAttachmentId, signal()))
    .toThrow(expect.objectContaining({ code: 'terminal/unavailable' }))
  await h.controller.create(h.agent, request, signal())
  h.handle.terminate.mockRejectedValueOnce(new Error('cleanup pending'))
  await expect(h.controller.close(h.agent, id)).rejects.toThrow('cleanup pending')
  expect(() => h.controller.follow(h.agent, id, 'view' as TerminalAttachmentId, signal()))
    .toThrow(expect.objectContaining({ code: 'terminal/unavailable' }))
  await expect(h.controller.create(h.agent, request, signal())).rejects.toMatchObject({ code: 'terminal/unavailable' })
})
