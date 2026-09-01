import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TerminalSessionService, { TerminalBackendCleanupError, TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import type { TerminalSendRequest, TerminalWaitReason } from '@deepseek-ai/dsh-terminal'
import { BashTerminalBackend, PWSH_PROMPT_SETUP } from '@deepseek-ai/dsh-terminal-bash'
import { ENCODING_PREAMBLE } from '@deepseek-ai/dsh-pwsh-local'
import * as ptyLocal from '@deepseek-ai/dsh-terminal-bash'
import type { ResolvedConfig } from '@deepseek-ai/dsh-terminal-bash/src/config.ts'
import type { LocalPtySession } from '@deepseek-ai/dsh-terminal-bash/src/session.ts'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

class EmptySandbox extends SandboxProvider {
  confine(_argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return { argv: [], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

class RecordingSandbox extends SandboxProvider {
  calls: { argv: readonly string[]; policy: SandboxPolicy }[] = []

  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    this.calls.push({ argv, policy })
    return { argv: ['/sandbox', '--', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function config(): ResolvedConfig {
  return {
    backendType: 'shell', shellDialect: 'bash', shellPath: '/bin/bash', shellArgs: [], rows: 24, cols: 80,
    scrollbackLines: 10, scrollbackMaxBytes: 100, maxReadBytes: 50,
    pollIntervalMs: 10, exactProbeAfterMs: 20, idleSilenceMs: 50, handoffGraceMs: 10, timeoutMs: 100,
    disposeGraceMs: 10,
  }
}

function agent(ctx: Context, cwd?: string): Agent {
  const id = SessionId('agent')
  const session = Session.create(id, undefined, { version: 0, id, createdAt: 0, ...cwd === undefined ? {} : { cwd } })
  return {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function terminalHandle(): SubprocessTerminalHandle {
  const output = new PassThrough()
  return {
    pid: 123,
    output,
    done: Promise.resolve({ exitCode: 0, signal: null }),
    write: async () => {},
    inspectForeground: async () => ({ processGroupId: 123, inputWaiting: true }),
    signalForeground: async () => 123,
    terminate: async () => { output.end() },
  }
}

class StubSubprocessRuntime extends SubprocessRuntime {
  async resolveExecutable(command: string): Promise<string> { return command }
  spawn(_spec: SubprocessSpawnSpec): SubprocessHandle { throw new Error('unused') }
  async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return terminalHandle()
  }
}

function spec(owner: Agent, signal?: AbortSignal) {
  return {
    sessionId: TerminalSessionId('pty-1'), owner, type: 'shell',
    ...signal !== undefined ? { signal } : {},
  }
}

function stubLocalSession(initialize: () => Promise<void> = () => Promise.resolve()): LocalPtySession {
  return {
    motd: '',
    initialize,
    startSend: () => { throw new Error('unused') },
    read: () => { throw new Error('unused') },
    signal: () => Promise.resolve({ delivered: true, targetPgid: 1 }),
    status: () => ({ kind: 'running' as const }),
    close: () => Promise.resolve(),
  } as unknown as LocalPtySession
}

function registerStubLocalBackend(ctx: Context, createSession: () => LocalPtySession) {
  return ctx.inject(['terminals', 'sandbox', 'sandboxPolicy', 'sessionProjections', 'subprocess'], (providerCtx) => {
    providerCtx.terminals.registerBackend(new BashTerminalBackend(
      providerCtx,
      { ...config(), backendType: 'stub' },
      async () => terminalHandle(),
      createSession,
    ))
  })
}

describe('BashTerminalBackend startup rollback', () => {
  it('rejects pre-aborted setup and empty sandbox argv', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: '/tmp' })
    const backend = new BashTerminalBackend(ctx, config(), async () => terminalHandle())
    const controller = new AbortController()
    const abortReason = new Error('spawn aborted')
    controller.abort(abortReason)
    await expect(backend.spawn(spec(agent(ctx), controller.signal))).rejects.toBe(abortReason)
    await expect(backend.spawn(spec(agent(ctx)))).rejects.toThrow('empty argv')
  })

  it('closes failed startup and aggregates cleanup failure', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    const spawnTerminal = async (): Promise<SubprocessTerminalHandle> => terminalHandle()

    const closed = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const failed = { initialize: () => Promise.reject(new Error('startup failed')), close: closed } as unknown as LocalPtySession
    const backend = new BashTerminalBackend(ctx, config(), spawnTerminal, () => failed)
    await expect(backend.spawn(spec(agent(ctx)))).rejects.toThrow('startup failed')
    expect(closed).toHaveBeenCalledWith('PTY startup failed')

    const startupFailure = new Error('startup failed')
    const cleanupFailure = new Error('cleanup failed')
    const doublyFailed = {
      initialize: () => Promise.reject(startupFailure),
      close: () => Promise.reject(cleanupFailure),
    } as unknown as LocalPtySession
    const aggregate = new BashTerminalBackend(ctx, config(), spawnTerminal, () => doublyFailed)
    await expect(aggregate.spawn(spec(agent(ctx)))).rejects.toEqual(expect.objectContaining({
      name: 'TerminalBackendCleanupError',
      spawnError: startupFailure,
      cleanupError: cleanupFailure,
    } satisfies Partial<TerminalBackendCleanupError>))
  })

  it('starts startup rollback when cancellation wins a stalled initialization', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    const initialization = Promise.withResolvers<undefined>()
    const initializationStarted = Promise.withResolvers<undefined>()
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const session = {
      initialize: () => {
        initializationStarted.resolve(undefined)
        return initialization.promise
      },
      close,
    } as unknown as LocalPtySession
    const backend = new BashTerminalBackend(ctx, config(), async () => terminalHandle(), () => session)
    const controller = new AbortController()
    const reason = new Error('cancel stalled startup')

    const spawning = backend.spawn(spec(agent(ctx), controller.signal))
    await initializationStarted.promise
    controller.abort(reason)

    await expect(spawning).rejects.toBe(reason)
    expect(close).toHaveBeenCalledWith('PTY startup failed')
    initialization.resolve(undefined)
  })

  it('wraps confined argv, scrubs the environment, and returns initialized sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(RecordingSandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/workspace' })
    const terminal = terminalHandle()
    let spawned: SubprocessTerminalSpawnSpec | undefined
    const spawnTerminal = async (spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> => {
      spawned = spec
      return terminal
    }
    const initialized = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const session = { initialize: initialized } as unknown as LocalPtySession
    const backend = new BashTerminalBackend(
      ctx,
      { ...config(), shellArgs: ['-i'] },
      spawnTerminal,
      () => session,
    )
    const previous = process.env.PTY_TEST_SECRET
    process.env.PTY_TEST_SECRET = 'must-not-leak'
    try {
      expect(await backend.spawn({ ...spec(agent(ctx)), cwd: '/work' })).toBe(session)
    } finally {
      if (previous === undefined) delete process.env.PTY_TEST_SECRET
      else process.env.PTY_TEST_SECRET = previous
    }

    expect(spawned).toMatchObject({
      argv: ['/sandbox', '--', '/bin/bash', '-i'],
      cols: 80,
      rows: 24,
      cwd: '/work',
      graceMs: 10,
      env: {
        TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', PS1: 'dsh> ', BASH_SILENCE_DEPRECATION_WARNING: '1',
        PROMPT_COMMAND: 'printf "\\033]133;D;%s\\007" "$?"; PS1=\'dsh> \'',
        DSH_SHELL: '1', DSH_SESSION_ID: 'agent', DSH_PTY_SESSION_ID: 'pty-1',
      },
    })
    expect(spawned?.env?.PTY_TEST_SECRET).toBeUndefined()
    expect(initialized).toHaveBeenCalledWith(undefined)
    expect((ctx.sandbox as RecordingSandbox).calls).toEqual([{
      argv: ['/bin/bash', '-i'],
      policy: { mode: 'workspace-write', sessionId: 'agent', workspaceRoot: resolve('/workspace') },
    }])
  })

  it('resolves session mode and root together before wrapping the shell', async () => {
    const ctx = new Context()
    await ctx.plugin(RecordingSandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: '/deployment-fallback' })
    const terminal = terminalHandle()
    let spawned: SubprocessTerminalSpawnSpec | undefined
    const spawnTerminal = async (spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> => {
      spawned = spec
      return terminal
    }
    const initialized = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const session = { initialize: initialized } as unknown as LocalPtySession
    const backend = new BashTerminalBackend(
      ctx,
      { ...config(), shellArgs: ['-i'] },
      spawnTerminal,
      () => session,
    )
    const owner = agent(ctx, '/session-workspace')
    setSandboxMode(owner.session, 'workspace-write')
    expect(await backend.spawn(spec(owner))).toBe(session)

    expect(spawned).toMatchObject({
      argv: ['/sandbox', '--', '/bin/bash', '-i'],
      cwd: resolve('/session-workspace'),
    })
    expect((ctx.sandbox as RecordingSandbox).calls).toEqual([{
      argv: ['/bin/bash', '-i'],
      policy: { mode: 'workspace-write', sessionId: 'agent', workspaceRoot: resolve('/session-workspace') },
    }])
  })

  it('rejects a confined spawn without a sandbox provider', async () => {
    const confinedCtx = new Context()
    await confinedCtx.plugin(SessionProjectionRegistry)
    await confinedCtx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/workspace' })
    const confined = new BashTerminalBackend(
      confinedCtx,
      config(),
      async () => { throw new Error('terminal spawn must not run') },
      () => stubLocalSession(),
    )
    await expect(confined.spawn(spec(agent(confinedCtx)))).rejects.toThrow(
      'sandbox mode "workspace-write" requires a ctx.sandbox provider in the execution world',
    )
  })

  it('forwards terminal allocation cancellation directly', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })

    const publishedController = new AbortController()
    let publishedSignal: AbortSignal | undefined
    const published = new BashTerminalBackend(
      ctx,
      config(),
      async (spawnSpec) => {
        publishedSignal = spawnSpec.signal
        return terminalHandle()
      },
      () => stubLocalSession(),
    )
    await published.spawn(spec(agent(ctx), publishedController.signal))
    expect(publishedSignal).toBe(publishedController.signal)
    publishedController.abort(new Error('originating turn ended'))
    expect(publishedSignal?.aborted).toBe(true)

    const pendingController = new AbortController()
    const seen = Promise.withResolvers<AbortSignal>()
    const pending = new BashTerminalBackend(
      ctx,
      config(),
      async spawnSpec => await new Promise<SubprocessTerminalHandle>((_resolve, reject) => {
        const setupSignal = spawnSpec.signal as AbortSignal
        seen.resolve(setupSignal)
        const onAbort = (): void => {
          reject(setupSignal.reason instanceof Error ? setupSignal.reason : new Error(String(setupSignal.reason)))
        }
        setupSignal.addEventListener('abort', onAbort, { once: true })
      }),
      () => stubLocalSession(),
    )
    const spawning = pending.spawn(spec(agent(ctx), pendingController.signal))
    const pendingSignal = await seen.promise
    const reason = new Error('cancel pending allocation')
    pendingController.abort(reason)
    await expect(spawning).rejects.toBe(reason)
    expect(pendingSignal.aborted).toBe(true)
  })

  it('composes the default local session around a spawned terminal', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    const output = new PassThrough()
    const outcome = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const terminal: SubprocessTerminalHandle = {
      pid: 123,
      output,
      done: outcome.promise,
      write: async () => {},
      inspectForeground: async () => ({ processGroupId: 123, inputWaiting: true }),
      signalForeground: async () => 123,
      async terminate() {
        output.end()
        outcome.resolve({ exitCode: null, signal: 'SIGTERM' })
      },
    }
    queueMicrotask(() => { output.write(Buffer.from('\x1b]133;D;0\x07dsh> ')) })
    const backend = new BashTerminalBackend(
      ctx,
      config(),
      async () => terminal,
    )
    const session = await backend.spawn(spec(agent(ctx)))
    expect(session.motd).toBe('dsh> ')
    await session.close('test complete')
  })

  it('bootstraps a pwsh dialect through the prompt function and scrubs bash-only env', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    let spawned: SubprocessTerminalSpawnSpec | undefined
    let sent: TerminalSendRequest | undefined
    const session = {
      motd: '',
      startSend: (request: TerminalSendRequest) => {
        sent = request
        return {
          done: Promise.resolve({
            viewport: 'setup-echo dsh> ', waitReason: 'stdin_read' as const,
            sessionStatus: { kind: 'running' as const }, truncated: false,
          }),
          readOutput: () => ({ delta: '', truncated: false }),
          cancel: () => false,
        }
      },
      read: () => ({ text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false }),
    } as unknown as LocalPtySession
    const backend = new BashTerminalBackend(
      ctx,
      { ...config(), shellDialect: 'pwsh', shellPath: 'pwsh' },
      async (spec) => { spawned = spec; return terminalHandle() },
      () => session,
    )
    expect(await backend.spawn(spec(agent(ctx)))).toBe(session)
    expect(sent).toMatchObject({ text: ENCODING_PREAMBLE + PWSH_PROMPT_SETUP, submit: true })
    expect(session.motd).toBe('setup-echo dsh> ')
    expect(spawned?.env).toMatchObject({
      TERM: 'dumb', NO_COLOR: '1', DSH_SHELL: '1', DSH_SESSION_ID: 'agent', DSH_PTY_SESSION_ID: 'pty-1',
    })
    expect(spawned?.env?.PS1).toBeUndefined()
    expect(spawned?.env?.PROMPT_COMMAND).toBeUndefined()
  })

  it('keeps waiting for stdin_read when the first settled output only echoes the prompt literal', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    const sends: TerminalSendRequest[] = []
    const session = {
      motd: '',
      startSend: (request: TerminalSendRequest) => {
        sends.push(request)
        const second = sends.length > 1
        return {
          done: Promise.resolve({
            viewport: second ? 'dsh> ' : "function prompt { 'dsh> ' }\n",
            waitReason: second ? 'stdin_read' as const : 'inferred_idle' as const,
            sessionStatus: { kind: 'running' as const }, truncated: false,
          }),
          readOutput: () => ({ delta: '', truncated: false }),
          cancel: () => false,
        }
      },
      read: () => ({ text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false }),
    } as unknown as LocalPtySession
    const backend = new BashTerminalBackend(
      ctx,
      { ...config(), shellDialect: 'pwsh', shellPath: 'pwsh' },
      async () => terminalHandle(),
      () => session,
    )
    await backend.spawn(spec(agent(ctx)))
    expect(sends).toHaveLength(2)
    expect(sends[1]).toMatchObject({ text: '', submit: false })
    expect(session.motd).toBe('dsh> ')
  })

  it('rejects a pwsh bootstrap whose shell exits or times out', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    const sessionFor = (waitReason: TerminalWaitReason): LocalPtySession => ({
      startSend: () => ({
        done: Promise.resolve({
          viewport: 'no-prompt', waitReason,
          sessionStatus: { kind: 'running' as const }, truncated: false,
        }),
        readOutput: () => ({ delta: '', truncated: false }),
        cancel: () => false,
      }),
      read: () => ({ text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false }),
      close: () => Promise.resolve(),
    }) as unknown as LocalPtySession
    const exited = new BashTerminalBackend(ctx, { ...config(), shellDialect: 'pwsh' }, async () => terminalHandle(), () => sessionFor('session_exit'))
    await expect(exited.spawn(spec(agent(ctx)))).rejects.toThrow('PTY shell exited during startup')
    const timedOut = new BashTerminalBackend(ctx, { ...config(), shellDialect: 'pwsh' }, async () => terminalHandle(), () => sessionFor('timeout'))
    await expect(timedOut.spawn(spec(agent(ctx)))).rejects.toThrow('did not reach readiness before startup timeout')
  })

  it('bounds all pwsh startup retries with one deadline', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(EmptySandbox)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
      const pending = Promise.withResolvers<{
        viewport: string
        waitReason: 'inferred_idle'
        sessionStatus: { kind: 'running' }
        truncated: boolean
      }>()
      let sends = 0
      let cancellations = 0
      let closes = 0
      const session = {
        motd: '',
        startSend: () => {
          sends += 1
          return {
            done: sends === 1
              ? Promise.resolve({
                viewport: 'setup echo', waitReason: 'inferred_idle' as const,
                sessionStatus: { kind: 'running' as const }, truncated: false,
              })
              : pending.promise,
            readOutput: () => ({ delta: '', truncated: false }),
            cancel: () => { cancellations += 1; return true },
          }
        },
        read: () => ({ text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false }),
        close: () => { closes += 1; return Promise.resolve() },
      } as unknown as LocalPtySession
      const backend = new BashTerminalBackend(
        ctx,
        { ...config(), shellDialect: 'pwsh', shellPath: 'pwsh' },
        async () => terminalHandle(),
        () => session,
      )

      const spawning = backend.spawn(spec(agent(ctx)))
      await vi.advanceTimersByTimeAsync(0)
      expect(sends).toBe(2)
      const rejected = expect(spawning).rejects.toThrow('did not reach readiness before startup timeout')
      await vi.advanceTimersByTimeAsync(100)

      await rejected
      expect(cancellations).toBe(1)
      expect(closes).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards the spawn signal into the pwsh bootstrap sends', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    const sends: TerminalSendRequest[] = []
    const session = {
      motd: '',
      startSend: (request: TerminalSendRequest) => {
        sends.push(request)
        return {
          done: Promise.resolve({
            viewport: 'dsh> ', waitReason: 'stdin_read' as const,
            sessionStatus: { kind: 'running' as const }, truncated: false,
          }),
          readOutput: () => ({ delta: '', truncated: false }),
          cancel: () => false,
        }
      },
      read: () => ({ text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false }),
    } as unknown as LocalPtySession
    const backend = new BashTerminalBackend(
      ctx,
      { ...config(), shellDialect: 'pwsh', shellPath: 'pwsh' },
      async () => terminalHandle(),
      () => session,
    )
    const signal = new AbortController().signal
    const spawned = await backend.spawn({ ...spec(agent(ctx)), signal })
    expect(spawned.motd).toBe('dsh> ')
    expect(sends).toHaveLength(1)
    expect(sends[0]?.signal).toBe(signal)
  })
})

describe('terminal-bash plugin shape', () => {
  it('keeps name, inject, and Config through Loader unwrapExports', () => {
    expect('default' in ptyLocal).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(ptyLocal) as Record<string, unknown>
    expect(unwrapped.name).toBe('terminal-bash')
    expect(unwrapped.inject).toEqual(['terminals', 'sandboxPolicy', 'sessionProjections', 'subprocess'])
    expect(unwrapped.Config).toBeDefined()
  })

  it('validates config and registers the configured backend', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    await ctx.plugin(StubSubprocessRuntime)
    const fiber = await ctx.plugin(ptyLocal, config())
    expect(ctx.terminals.listBackends()).toEqual(['shell'])
    await fiber.dispose()
    expect(ctx.terminals.listBackends()).toEqual([])
  })

  it('ignores unrelated session events and mode changes without a live owner', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    await ctx.plugin(StubSubprocessRuntime)
    await ctx.plugin(ptyLocal, config())

    const session = ctx.sessions.create(SessionId('unowned-mode'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
    }).not.toThrow()
    expect(() => { setSandboxMode(session, 'read-only') }).not.toThrow()
  })

  it('keeps the owner-lifetime sandbox fence after the local provider unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(RecordingSandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    await ctx.plugin(StubSubprocessRuntime)

    const session = ctx.sessions.create(SessionId('mode-owner'))
    const ownerFiber = await ctx.plugin(() => {})
    const owner: Agent = {
      id: session.id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      ctx: ownerFiber.ctx,
      send: () => {},
      followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(owner)
    const providerFiber = await registerStubLocalBackend(ctx, () => stubLocalSession())
    const created = await ctx.terminals.spawn(owner, { type: 'stub' })

    const unrelated = ctx.sessions.create(SessionId('unrelated-mode'))
    expect(() => { setSandboxMode(unrelated, 'read-only') }).not.toThrow()
    expect(() => {
      session.append('turn/start', { turn: 1 })
    }).not.toThrow()

    expect(() => { setSandboxMode(session, 'danger-full-access') }).not.toThrow()
    await providerFiber.dispose()
    expect(ctx.terminals.listBackends()).toEqual([])
    expect(() => { setSandboxMode(session, 'read-only') }).toThrow(
      'cannot change sandbox mode from "danger-full-access" to "read-only" while persistent terminal sessions are open or being created; wait for creation to settle and close them first',
    )
    expect(session.snapshotEvents().filter(event => event.type === 'sandbox/mode')).toHaveLength(1)

    const replacementFiber = await registerStubLocalBackend(ctx, () => stubLocalSession())
    const second = await ctx.terminals.spawn(owner, { type: 'stub' })
    await replacementFiber.dispose()
    expect(() => { setSandboxMode(session, 'read-only') }).toThrow('open or being created')

    await ctx.terminals.kill(owner, created.sessionId)
    await ctx.terminals.kill(owner, second.sessionId)
    expect(() => { setSandboxMode(session, 'read-only') }).not.toThrow()
    expect(session.snapshotEvents().filter(event => event.type === 'sandbox/mode')).toHaveLength(2)
  })

  it('also fences sandbox-mode changes across unpublished PTY creation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(RecordingSandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    await ctx.plugin(StubSubprocessRuntime)

    const session = ctx.sessions.create(SessionId('pending-mode-owner'))
    const ownerFiber = await ctx.plugin(() => {})
    const owner: Agent = {
      id: session.id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      ctx: ownerFiber.ctx,
      send: () => {},
      followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(owner)
    const gate = Promise.withResolvers<undefined>()
    await registerStubLocalBackend(ctx, () => stubLocalSession(() => gate.promise))
    const spawning = ctx.terminals.spawn(owner, { type: 'stub' })

    expect(ctx.terminals.hasOwnerActivity(owner)).toBe(true)
    expect(() => { setSandboxMode(session, 'read-only') }).toThrow('open or being created')
    gate.resolve(undefined)
    const created = await spawning
    await ctx.terminals.kill(owner, created.sessionId)
    expect(ctx.terminals.hasOwnerActivity(owner)).toBe(false)
  })
})
