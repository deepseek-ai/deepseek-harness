import { Context } from '@deepseek-ai/cordis'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcBindingFunction, PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import PtcWorkflowEngine from '../src/index.ts'
import { fakeParent } from './setup.ts'

const completed: PtcRunResult = { logs: [], value: { value: null, stopReason: 'completed', agentsStarted: 0 } }
type HostBindings = Record<string, PtcBindingFunction>

class ControlledRuntime extends PtcRuntime {
  language = 'typescript'
  readonly isolation = 'process'
  execute: (spec: PtcRunSpec) => Promise<PtcRunResult> = () => Promise.resolve(completed)

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs === undefined ? 120_000 : request.timeoutMs }
  }

  run(spec: PtcRunSpec): Promise<PtcRunResult> { return this.execute(spec) }
}

async function setup(execute?: (bindings: HostBindings, spec: PtcRunSpec) => Promise<PtcRunResult>, language = 'typescript') {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'read-only' })
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider({
    name: 'stub',
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    start: async () => ({
      id: SessionId('host-child'),
      localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }),
      dispose: () => Promise.resolve(),
    }),
  })
  await ctx.plugin(ControlledRuntime)
  const runtime = ctx.ptcRuntime as ControlledRuntime
  runtime.language = language
  if (execute !== undefined) runtime.execute = spec => execute(spec.bindings[0]!.functions, spec)
  await ctx.plugin(PtcWorkflowEngine, { provider: 'stub' })
  const parent = fakeParent(ctx)
  const start = () => ctx.workflowEngine.start({
    script: 'return null', meta: { name: 'host-test', description: 'workflow callbacks' }, parent,
  })
  return { ctx, runtime, start, parent }
}

describe('workflow host callback validation', () => {
  it.each([
    ['startChild', null, 'requires an object'],
    ['startChild', [], 'requires an object'],
    ['startChild', { prompt: 7 }, 'prompt must be a string'],
    ['startChild', { prompt: 'p', provider: 7 }, 'provider must be a string'],
    ['startChild', { prompt: 'p', model: false }, 'model must be a string'],
    ['progress', {}, 'requires an array of events'],
    ['progress', [{ type: 'phase', title: null }], 'phase must be a string'],
    ['progress', [{ type: 'agent-start', info: { seq: 0 } }], 'sequence must be a positive integer'],
    ['progress', [{ type: 'agent-end', info: { outcome: 'unknown' } }], 'invalid workflow agent outcome'],
    ['progress', [{ type: 'unknown' }], 'invalid workflow progress event'],
    ['childResult', { callId: '1' }, 'call id must be an integer'],
    ['disposeChild', { callId: 99 }, 'child call is not active'],
  ] as const)('rejects malformed %s callback data %j', async (name, input, message) => {
    const { start } = await setup(async (bindings) => {
      await expect(Promise.resolve().then(() => bindings[name]!(input))).rejects.toThrow(message)
      return completed
    })
    const handle = start()
    try { expect((await handle.result).stopReason).toBe('completed') }
    finally { await handle.dispose() }
  })

  it('does not emit duplicate agent-end notifications', async () => {
    const info = { seq: 1, label: 'child', childId: 'host-child' }
    const { ctx, start } = await setup(async (bindings) => {
      await bindings.progress!([{ type: 'agent-start', info }])
      await bindings.progress!([{ type: 'agent-end', info: { ...info, outcome: 'failed' } }])
      await bindings.progress!([{ type: 'agent-end', info: { ...info, outcome: 'cancelled' } }])
      return completed
    })
    const ended = vi.fn()
    ctx.on('workflow/agent-end', ended)
    const handle = start()
    try {
      expect((await handle.result).stopReason).toBe('completed')
      expect(ended).toHaveBeenCalledOnce()
    } finally { await handle.dispose() }
  })

  it('carries Session authority and an explicit unlimited deadline to the runtime', async () => {
    const { ctx, parent, start } = await setup(async (bindings, spec) => {
      expect(spec.timeoutMs).toBeNull()
      expect(spec.cwd).toBe(parent.session.header.cwd)
      expect(spec.sandboxPolicy).toEqual(ctx.sandboxPolicy.resolve({ session: parent.session }))
      expect(await bindings.begin!({})).toMatchObject({ body: 'return null', meta: { name: 'host-test' } })
      return completed
    })
    const handle = start()
    try { expect((await handle.result).stopReason).toBe('completed') }
    finally { await handle.dispose() }
  })
})

describe('workflow runtime outcomes', () => {
  it.each([
    [null, 'requires an object'],
    [{ value: null, stopReason: 'unknown', agentsStarted: 0 }, 'invalid workflow stop reason'],
    [{ value: null, stopReason: 'cancelled', agentsStarted: -1 }, 'invalid workflow agent count'],
    [{ stopReason: 'completed', agentsStarted: 0 }, 'missing its value'],
    [{ value: null, stopReason: 'error', agentsStarted: 0, error: 5 }, 'error must be a string'],
  ] as const)('maps an invalid terminal result %j to a workflow error', async (value, message) => {
    const { start } = await setup(() => Promise.resolve({ logs: [], value }))
    const handle = start()
    try {
      const result = await handle.result
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain(message)
    } finally { await handle.dispose() }
  })

  it('preserves cancellation when the runtime rejects during cancellation', async () => {
    const entered = Promise.withResolvers<undefined>()
    const failure = Promise.withResolvers<PtcRunResult>()
    const { start } = await setup(() => { entered.resolve(undefined); return failure.promise })
    const handle = start()
    try {
      await entered.promise
      handle.cancel('stop requested')
      failure.reject(new Error('execution provider failed while stopping'))
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('stop requested')
    } finally {
      failure.reject(new Error('test cleanup'))
      await handle.dispose()
    }
  })

  it('rejects a non-TypeScript runtime while loading the workflow provider', async () => {
    await expect(setup(undefined, 'python')).rejects.toThrow('requires the Node TypeScript PTC runtime')
  })

  it('stops waiting for child output after disposal releases the child resources', async () => {
    const childResult = Promise.withResolvers<SubagentResult>()
    const disposed = vi.fn(() => Promise.resolve())
    let outputWait: Promise<unknown> | undefined
    const { ctx, start } = await setup(async (bindings) => {
      const child = await bindings.startChild!({ prompt: 'child' })
      outputWait = bindings.childResult!(child)
      void outputWait.catch(() => {})
      return completed
    })
    vi.spyOn(ctx.subagents.getProvider('stub')!, 'start').mockResolvedValue({
      id: SessionId('output-pending'), localAgent: undefined, result: childResult.promise, dispose: disposed,
    })
    const handle = start()
    let settled = false
    void handle.result.then(() => { settled = true })
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(settled).toBe(true)
      expect(disposed).toHaveBeenCalledOnce()
      await expect(outputWait).rejects.toBe('workflow settled')
      expect((await handle.result).stopReason).toBe('completed')
    } finally {
      childResult.resolve({ output: [], stopReason: 'aborted' })
      await handle.dispose()
    }
  })
})
