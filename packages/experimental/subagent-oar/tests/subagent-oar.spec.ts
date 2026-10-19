import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { defaultRuntimes } from '@botiverse/oar'
import type { Event, Runtime, Session, SessionOptions } from '@botiverse/oar'
import { scriptedRuntime } from '@botiverse/oar/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { externalTestParent } from '../../../subagent/subagent/tests/external-activation-helpers.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import * as oar from '../src/index.ts'
import { startOarRun, textTask } from '../src/run.ts'
import * as subprocess from '@deepseek-ai/dsh-subprocess'
import { oarEnvironment } from '../src/environment.ts'
import type { OarRunSpec } from '../src/run.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function request(signal = new AbortController().signal): Promise<ResolvedSubagentStartRequest> {
  const ctx = new Context()
  const parent = await externalTestParent(ctx, process.cwd())
  return { parent, cwd: process.cwd(), signal, prompt: [{ type: 'text', text: 'Complete the task.' }] }
}

function spec(runtime: Runtime, overrides: Partial<OarRunSpec> = {}): OarRunSpec {
  return { runtime, env: {}, launchArgs: [], timeoutMs: 60_000, ...overrides }
}

function observedRuntime(base = scriptedRuntime({ id: 'future-runtime', turn: (turn) => { turn.say('answer') } })) {
  const opened = Promise.withResolvers<Session>()
  const options: SessionOptions[] = []
  const dispose = vi.fn<Session['dispose']>()
  const abort = vi.fn<Session['abort']>()
  const runtime: Runtime = {
    ...base,
    session: async (installation, sessionOptions) => {
      options.push(sessionOptions)
      const session = await base.session(installation, sessionOptions)
      dispose.mockImplementation(() => session.dispose())
      abort.mockImplementation(() => session.abort())
      const wrapped = { ...session, dispose, abort }
      opened.resolve(wrapped)
      return wrapped
    },
  }
  return { runtime, options, opened: opened.promise, dispose, abort }
}

describe('OAR provider composition', () => {
  it('loads named exports and releases only its own registration', async () => {
    expect('default' in oar).toBe(false)
    const loader = new Loader(new Context())
    expect(loader.unwrapExports(oar)).toBe(oar)
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await mountWorkingDirectoryFixture(ctx)
      await ctx.plugin(SubagentRuntime)
      const first = await ctx.plugin(oar, { runtime: 'codex', providerName: 'codex-test', timeoutMs: 120_000 })
      const second = await ctx.plugin(oar, { runtime: 'claude', providerName: 'claude-test' })
      expect(ctx.subagents.getProvider('codex-test')).toMatchObject({
        name: 'codex-test',
        capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
        inheritsParentContext: false,
      })
      await first.dispose()
      expect(ctx.subagents.getProvider('codex-test')).toBeUndefined()
      expect(ctx.subagents.getProvider('claude-test')).toBeDefined()
      await second.dispose()
      expect(ctx.subagents.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a runtime that OAR does not register', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await mountWorkingDirectoryFixture(ctx)
      await ctx.plugin(SubagentRuntime)
      await expect(ctx.plugin(oar, { runtime: 'missing-oar-runtime' })).rejects.toThrow('unknown runtime')
    } finally {
      await ctx.fiber.dispose()
    }
  })
  it('executes a registered provider with configured model and effort and reports cleanup failure', async () => {
    const selected = defaultRuntimes.require('codex')
    const base = scriptedRuntime({ turn: (turn) => { turn.say('registered answer') } })
    const options: SessionOptions[] = []
    vi.spyOn(selected, 'installation').mockResolvedValue({ kind: 'available', via: 'bundled' })
    vi.spyOn(selected, 'session').mockImplementation(async (_installation, sessionOptions) => {
      options.push(sessionOptions)
      const { effort: _effort, ...supported } = sessionOptions
      const session = await base.session({ kind: 'available', via: 'bundled' }, supported)
      return { ...session, dispose: async () => {
        await session.dispose()
        throw new Error('private cleanup detail')
      } }
    })
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await mountWorkingDirectoryFixture(ctx)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(oar, { runtime: 'codex', model: 'native-model', effort: 'high' })
      const provider = ctx.subagents.getProvider('oar')
      const run = await provider!.start!(await request())
      await expect(run.result).resolves.toMatchObject({ output: [{ type: 'text', text: 'registered answer' }] })
      await expect(run.dispose()).rejects.toThrow('stage: dispose')
      expect(options[0]).toMatchObject({ model: 'native-model', effort: 'high' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects timeout values beyond the platform timer range for direct composition', () => {
    const ctx = new Context()
    expect(() =>{  oar.apply(ctx, { runtime: 'codex', timeoutMs: 2 ** 31 }) }).toThrow('no greater than')
  })

  it('supports direct provider composition with the declared defaults', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await mountWorkingDirectoryFixture(ctx)
      await ctx.plugin(SubagentRuntime)
      oar.apply(ctx, { runtime: 'codex' })
      expect(ctx.subagents.getProvider('oar')).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

})

describe('OAR task input', () => {
  it('preserves consecutive text and rejects non-text or blank input', () => {
    expect(textTask([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }])).toBe('onetwo')
    expect(() => textTask([])).toThrow()
    expect(() => textTask([{ type: 'text', text: ' \n ' }])).toThrow()
    expect(() => textTask([{ type: 'reasoning', text: 'private' }])).toThrow()
  })

  it('removes inherited credentials and retains explicit environment deletion', () => {
    vi.stubEnv('OAR_FIXTURE_API_TOKEN', 'private')
    vi.stubEnv('DSH_OAR_DELETE_ME', 'inherited')
    const environment = oarEnvironment({ DSH_OAR_DELETE_ME: null, DSH_OAR_KEEP_ME: 'supplied' })
    expect(environment.OAR_FIXTURE_API_TOKEN).toBeNull()
    expect(environment.DSH_OAR_DELETE_ME).toBeNull()
    expect(environment.DSH_OAR_KEEP_ME).toBe('supplied')
    expect(process.env.DSH_OAR_DELETE_ME).toBe('inherited')
  })
  it('forwards shared environment corrections without copying unchanged ambient values', () => {
    const inherited = process.env.OAR_FIXTURE_PROXY_VALUE
    const corrected = `${inherited ?? ''}:corrected`
    const scrubbed = subprocess.scrubbedParentEnv()
    vi.spyOn(subprocess, 'scrubbedParentEnv').mockReturnValue({
      ...scrubbed, OAR_FIXTURE_PROXY_VALUE: corrected,
    })
    const overlay = oarEnvironment({})
    expect(overlay.OAR_FIXTURE_PROXY_VALUE).toBe(corrected)
    expect(overlay).not.toHaveProperty('PATH')
  })

})

describe('OAR one-shot execution', () => {

  it('passes deployment environment overlays to installation probes', async () => {
    const observed = observedRuntime()
    const installation = vi.fn(observed.runtime.installation)
    const run = await startOarRun(await request(), spec({
      ...observed.runtime, installation,
    }, { env: { OAR_EXPLICIT_TOKEN: 'configured', OAR_DELETE: null } }))
    await run.result
    await run.dispose()
    const overlay = installation.mock.calls[0]?.[0]?.env
    expect(overlay).toMatchObject({ OAR_EXPLICIT_TOKEN: 'configured', OAR_DELETE: null })
    expect(overlay).not.toHaveProperty('PATH')
  })
  it('runs an arbitrary runtime and returns only root assistant text', async () => {
    const base = scriptedRuntime({
      id: 'a-future-oar-runtime',
      turn: async (turn) => {
        turn.think('private reasoning')
        turn.say('hello')
        await turn.tool('Read', 'private tool input', () => 'private tool output')
        turn.say(' world')
      },
    })
    const runtime: Runtime = {
      ...base,
      session: async (installation, options) => {
        const session = await base.session(installation, options)
        return {
          ...session,
          events: (observer, eventOptions) => session.events((event) => {
            if (event.kind === 'text_delta') {
              const child: Event = { ...event, agentPath: ['child'], text: 'private child output' }
              observer(child)
            }
            observer(event)
          }, eventOptions),
        }
      },
    }
    const observed = observedRuntime(runtime)
    const run = await startOarRun(await request(), spec(observed.runtime, {
      model: 'configured-model', env: { REMOVE: null, KEEP: 'value' }, launchArgs: ['--native-setting'],
    }))
    await expect(run.result).resolves.toEqual({ output: [{ type: 'text', text: 'hello world' }], stopReason: 'completed' })
    await Promise.all([run.dispose(), run.dispose()])
    expect(observed.dispose).toHaveBeenCalledOnce()
    expect(observed.options[0]).toMatchObject({
      cwd: process.cwd(), model: 'configured-model', env: { REMOVE: null, KEEP: 'value' }, launchArgs: ['--native-setting'],
    })
  })

  it('accepts a successful empty answer', async () => {
    const observed = observedRuntime(scriptedRuntime({ turn: () => {} }))
    const run = await startOarRun(await request(), spec(observed.runtime))
    await expect(run.result).resolves.toMatchObject({ output: [], stopReason: 'completed' })
    await run.dispose()
  })

  it('does not install a runtime whose installation is missing', async () => {
    const base = scriptedRuntime({ turn: () => {} })
    const install = vi.fn<NonNullable<Runtime['install']>>()
    const session = vi.fn(base.session)
    const runtime: Runtime = { ...base, install, session, installation: async () => ({ kind: 'not_found' }) }
    await expect(startOarRun(await request(), spec(runtime))).rejects.toThrow()
    expect(install).not.toHaveBeenCalled()
    expect(session).not.toHaveBeenCalled()
  })

  it('rejects a runtime with no installation probe', async () => {
    const base = scriptedRuntime({ turn: () => {} })
    const { installation: _installation, ...runtime } = base
    await expect(startOarRun(await request(), spec(runtime))).rejects.toThrow()
  })

  it('does not open after cancellation wins installation probing', async () => {
    const probed = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const base = scriptedRuntime({ turn: () => {} })
    const session = vi.fn(base.session)
    const runtime: Runtime = {
      ...base, session,
      installation: async () => {
        probed.resolve(undefined)
        await release.promise
        return { kind: 'available', via: 'bundled' }
      },
    }
    const controller = new AbortController()
    const opening = startOarRun(await request(controller.signal), spec(runtime))
    const rejected = expect(opening).rejects.toThrow()
    await probed.promise
    controller.abort()
    release.resolve(undefined)
    await rejected
    expect(session).not.toHaveBeenCalled()
  })

  it('disposes a late session before rejecting canceled startup', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observed = observedRuntime()
    const runtime: Runtime = {
      ...observed.runtime,
      session: async (installation, options) => {
        entered.resolve(undefined)
        await release.promise
        return observed.runtime.session(installation, options)
      },
    }
    const controller = new AbortController()
    const opening = startOarRun(await request(controller.signal), spec(runtime))
    const rejected = expect(opening).rejects.toThrow()
    await entered.promise
    controller.abort()
    release.resolve(undefined)
    await rejected
    expect(observed.dispose).toHaveBeenCalledOnce()
  })

  it('does not probe an already aborted request', async () => {
    const observed = observedRuntime()
    const probe = vi.fn(observed.runtime.installation)
    const controller = new AbortController()
    controller.abort()
    await expect(startOarRun(await request(controller.signal), spec({ ...observed.runtime, installation: probe }))).rejects.toThrow()
    expect(probe).not.toHaveBeenCalled()
  })

  it('settles cancellation with partial text and disposes once', async () => {
    const active = Promise.withResolvers<undefined>()
    const observed = observedRuntime(scriptedRuntime({
      turn: async (turn) => {
        turn.say('partial')
        active.resolve(undefined)
        await new Promise<void>((resolve) =>{  turn.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      },
    }))
    const controller = new AbortController()
    const run = await startOarRun(await request(controller.signal), spec(observed.runtime))
    await active.promise
    controller.abort()
    await expect(run.result).resolves.toMatchObject({ output: [{ type: 'text', text: 'partial' }], stopReason: 'aborted' })
    await run.dispose()
    expect(observed.abort).toHaveBeenCalledOnce()
    expect(observed.dispose).toHaveBeenCalledOnce()
  })

  it('lets a turn continue without a configured deadline', async () => {
    const active = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observed = observedRuntime(scriptedRuntime({ turn: async (turn) => {
      active.resolve(undefined)
      await release.promise
      turn.say('long task completed')
    } }))
    const requested = await request()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const run = await startOarRun(requested, { runtime: observed.runtime, env: {}, launchArgs: [] })
    try {
      await active.promise
      await vi.advanceTimersByTimeAsync(600_001)
      expect(observed.abort).not.toHaveBeenCalled()
      release.resolve(undefined)
      await expect(run.result).resolves.toMatchObject({
        stopReason: 'completed', output: [{ type: 'text', text: 'long task completed' }],
      })
    } finally {
      release.resolve(undefined)
      await run.dispose()
    }
  })

  it('bounds an active turn without depending on model cooperation', async () => {
    const active = Promise.withResolvers<undefined>()
    const observed = observedRuntime(scriptedRuntime({
      turn: async (turn) => {
        active.resolve(undefined)
        await new Promise<void>((resolve) =>{  turn.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      },
    }))
    const run = await startOarRun(await request(), spec(observed.runtime, { timeoutMs: 10 }))
    await active.promise
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    await run.dispose()
    expect(observed.dispose).toHaveBeenCalledOnce()
  })

  it('reports runtime failures without exposing native exception text', async () => {
    const observed = observedRuntime(scriptedRuntime({ turn: () => { throw new Error('SECRET_NATIVE_TEXT') } }))
    const run = await startOarRun(await request(), spec(observed.runtime))
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBeTruthy()
    expect(JSON.stringify(result)).not.toContain('SECRET_NATIVE_TEXT')
    await run.dispose()
  })

  it('retains completed output when cleanup fails and reports the failure', async () => {
    const base = scriptedRuntime({ turn: (turn) => { turn.say('completed answer') } })
    const runtime: Runtime = {
      ...base,
      session: async (installation, options) => {
        const session = await base.session(installation, options)
        return {
          ...session,
          dispose: async () => { await session.dispose(); throw new Error('cleanup detail') },
        }
      },
    }
    const onError = vi.fn()
    const run = await startOarRun(await request(), spec(runtime, { onError }))
    const result = await run.result
    expect(result.output).toEqual([{ type: 'text', text: 'completed answer' }])
    await expect(run.dispose()).rejects.toThrow('stage: dispose')
    expect(onError).toHaveBeenCalled()
  })
  it('selects the last non-empty identified root message', async () => {
    const base = scriptedRuntime({ turn: (turn) => {
      turn.say('progress')
      turn.say('final ')
      turn.say('answer')
      turn.say('')
    } })
    const runtime: Runtime = {
      ...base,
      session: async (installation, options) => {
        const session = await base.session(installation, options)
        return { ...session, events: (observer, eventOptions) => session.events((event) => {
          observer(event.kind === 'text_delta'
            ? { ...event, messageId: event.text === 'progress' ? 'progress' : event.text === '' ? 'empty' : 'answer' }
            : event)
        }, eventOptions) }
      },
    }
    const run = await startOarRun(await request(), spec(runtime))
    await expect(run.result).resolves.toMatchObject({ output: [{ type: 'text', text: 'final answer' }] })
    await run.dispose()
  })

  it('rejects an inaccessible directory before installation probing', async () => {
    const observed = observedRuntime()
    const probe = vi.fn(observed.runtime.installation)
    await expect(startOarRun({ ...await request(), cwd: '/missing-oar-unit-directory' }, spec({
      ...observed.runtime, installation: probe,
    }))).rejects.toThrow('/missing-oar-unit-directory')
    expect(probe).not.toHaveBeenCalled()
  })

  it('retains a failed probe cause while reporting only its safe summary', async () => {
    const cause = new Error('PRIVATE_PROBE_DETAIL')
    const onError = vi.fn<NonNullable<OarRunSpec['onError']>>()
    const runtime = {
      ...scriptedRuntime({ turn: () => {} }),
      installation: async () => { throw cause },
    }
    await expect(startOarRun(await request(), spec(runtime, { onError }))).rejects.toMatchObject({ cause })
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]?.[0].message).toContain('stage: installation; category: unknown')
    expect(onError.mock.calls[0]?.[0].cause).toBe(cause)
    expect(onError.mock.calls[0]?.[0].message).not.toContain('PRIVATE_PROBE_DETAIL')
  })

  it('classifies startup failure and keeps cancellation precedence', async () => {
    const controller = new AbortController()
    const base = scriptedRuntime({ turn: () => {} })
    const runtime: Runtime = { ...base, session: async () => { throw new Error('PRIVATE_START_DETAIL') } }
    await expect(startOarRun(await request(), spec(runtime, { effort: 'high' }))).rejects.toThrow('stage: startup; category: unknown')
    const canceled: Runtime = { ...base, session: async () => {
      controller.abort()
      throw new Error('PRIVATE_START_DETAIL')
    } }
    await expect(startOarRun(await request(controller.signal), spec(canceled))).rejects.toThrow('category: cancelled')
  })

  it('cleans an opened session when event subscription fails', async () => {
    const observed = observedRuntime()
    const runtime: Runtime = { ...observed.runtime, session: async (installation, options) => {
      const session = await observed.runtime.session(installation, options)
      return { ...session, events: () => { throw new Error('subscriber failed') } }
    } }
    await expect(startOarRun(await request(), spec(runtime))).rejects.toThrow('stage: startup')
    expect(observed.dispose).toHaveBeenCalledOnce()
  })

  it('settles a rejected prompt without repeating the native rejection text', async () => {
    const base = scriptedRuntime({ turn: async turn => new Promise<void>((resolve) =>{  turn.signal.addEventListener('abort', () => { resolve() }, { once: true }) }) })
    const runtime: Runtime = { ...base, session: async (installation, options) => {
      const session = await base.session(installation, options)
      await session.prompt('occupy this native session')
      return session
    } }
    const run = await startOarRun(await request(), spec(runtime))
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('category: busy')
    await run.dispose()
  })

  it('turns a transport exception into an error result', async () => {
    const observed = observedRuntime()
    const runtime: Runtime = { ...observed.runtime, session: async (installation, options) => {
      const session = await observed.runtime.session(installation, options)
      return { ...session, prompt: async () => { throw new Error('PRIVATE_TRANSPORT_DETAIL') } }
    } }
    const onError = vi.fn()
    const run = await startOarRun(await request(), spec(runtime, { onError }))
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('stage: turn')
    expect(onError).toHaveBeenCalled()
    await run.dispose()
  })

  it('reports abort failure and keeps disposing when the diagnostic observer throws', async () => {
    const entered = Promise.withResolvers<undefined>()
    const base = scriptedRuntime({ turn: async (turn) => {
      entered.resolve(undefined)
      await new Promise<void>((resolve) =>{  turn.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    } })
    const runtime: Runtime = { ...base, session: async (installation, options) => {
      const session = await base.session(installation, options)
      return { ...session, abort: async () => { throw new Error('abort failed') } }
    } }
    const controller = new AbortController()
    const onError = vi.fn<NonNullable<OarRunSpec['onError']>>(() => { throw new Error('observer failed') })
    const run = await startOarRun(await request(controller.signal), spec(runtime, { onError }))
    await entered.promise
    controller.abort()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    await run.dispose()
    expect(onError.mock.calls[0]?.[0].message).toContain('stage: abort')
    expect(onError.mock.calls[0]?.[1]).toBe('error')
  })

  it('cancels a session that aborts while its event subscription is attached', async () => {
    const controller = new AbortController()
    const observed = observedRuntime()
    const runtime: Runtime = { ...observed.runtime, session: async (installation, options) => {
      const session = await observed.runtime.session(installation, options)
      return { ...session, events: (observer, eventOptions) => {
        const unsubscribe = session.events(observer, eventOptions)
        controller.abort()
        return unsubscribe
      } }
    } }
    await expect(startOarRun(await request(controller.signal), spec(runtime))).rejects.toThrow('category: cancelled')
    expect(observed.dispose).toHaveBeenCalledOnce()
  })

  it('observes cleanup rejection during cancellation without an unhandled rejection', async () => {
    const active = Promise.withResolvers<undefined>()
    const base = scriptedRuntime({ turn: async (turn) => {
      active.resolve(undefined)
      await new Promise<void>((resolve) =>{  turn.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    } })
    const runtime: Runtime = { ...base, session: async (installation, options) => {
      const session = await base.session(installation, options)
      return { ...session, dispose: async () => {
        await session.dispose()
        throw new Error('private disposal failure')
      } }
    } }
    const controller = new AbortController()
    const run = await startOarRun(await request(controller.signal), spec(runtime))
    await active.promise
    controller.abort()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    await expect(run.dispose()).rejects.toThrow('stage: dispose')
  })

})
