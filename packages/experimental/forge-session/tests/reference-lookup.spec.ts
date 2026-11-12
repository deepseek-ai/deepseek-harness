/** Reference observation through Cordis services without a platform shell or CLI process. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { type ToolCallId } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, type SessionId } from '@deepseek-ai/dsh-session'
import ShellExecutor from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { bench, pullUrl } from './fixtures.ts'

const contexts: Context[] = []
const releases: (() => void)[] = []

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function output(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1_234,
    stdout: { text: JSON.stringify({ url: pullUrl(9) }), truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

function execution(result: () => Promise<ShellRunResult>): ShellExecution {
  const reader = { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) }
  return {
    status: 'completed', exitCode: 0, signal: null, done: Promise.resolve(),
    observed: { stdout: reader, stderr: reader },
    readOutput: () => ({ delta: '', lossy: false }), kill: () => false, result,
  }
}

class LookupShell extends ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      ...request,
      workdir: request.workdir ?? process.cwd(), timeoutMs: request.timeoutMs ?? 1_234,
      onExpiry: 'kill', stdoutMaxBytes: 64_000, sandboxPolicy: request.sandboxPolicy,
    }
  }

  async execute(): Promise<ShellExecution> {
    return execution(async () => output())
  }
}

async function fixture() {
  const b = await bench({ discoveryTimeoutMs: 1_234 })
  const { ctx } = b
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ShellEnv, { dshHome: process.cwd() })
  await ctx.plugin(LookupShell)
  const { agent } = await ctx.agents.create({ sessionId: brandString<SessionId>('reference-observer') })
  const controller = new AbortController()
  const exec: ToolExecution = {
    name: 'bash', agent,
    callId: brandString<ToolCallId>('reference'), rootCallId: brandString<ToolCallId>('reference'), token: Symbol('reference') as ToolExecutionToken,
    arguments: { command: 'gh pr view 9 -R octo/demo --json number' }, signal: controller.signal,
  }
  const result: ToolExecutionResult = {
    isError: false, content: [{ type: 'text', text: '{"number":9}' }],
    value: { kind: 'foreground', cwd: process.cwd(), exitCode: 0, signal: null, timedOut: false, aborted: false },
  }
  const records = () => agent.session.snapshotEvents().flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:forge-session/binding' ? [record.data] : []
  })
  const execute = vi.spyOn(ctx.shell, 'execute')
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const emit = (call: ToolExecution = exec, outcome: ToolExecutionResult = result) => { ctx.emit('tools/result', call, outcome) }
  return { ...b, agent, exec, result, controller, records, execute, warn, emit }
}

describe('PR reference lookup', () => {
  it('records the resolved URL with the caller cwd and environment, without restoring a dismissed binding', async () => {
    const f = await fixture()
    const resolve = vi.spyOn(f.ctx.shell, 'resolve')
    f.emit()
    await vi.waitFor(() => { expect(f.records()).toEqual([{ action: 'reference', url: pullUrl(9) }]) })
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      command: 'env gh pr view 9 --repo octo/demo --json url', workdir: process.cwd(), timeoutMs: 1_234,
      dshEnv: f.ctx.shellEnv.collect(f.exec),
    }))
    f.ctx.forgeSession.dismiss(f.agent.session, pullUrl(9))
    f.emit()
    expect(f.execute).toHaveBeenCalledTimes(2)
    const returned = f.execute.mock.results[1]
    if (returned?.type !== 'return') throw new Error('missing second lookup')
    await (await returned.value).result()
    await f.service.dispose()
    expect(f.records()).toEqual([{ action: 'reference', url: pullUrl(9) }, { action: 'dismiss', url: pullUrl(9) }])
    expect(f.warn).not.toHaveBeenCalled()
  })

  it.each([
    ['failed exit', { exitCode: 1 }],
    ['signal', { signal: 'SIGTERM' }],
    ['timeout', { timedOut: true }],
    ['abort result', { aborted: true }],
    ['truncated output', { stdout: { text: '{', truncated: true } }],
    ['invalid JSON', { stdout: { text: '{', truncated: false } }],
    ['missing URL', { stdout: { text: '{}', truncated: false } }],
    ['non-PR URL', { stdout: { text: '{"url":"https://fake.test/octo/demo/issues/9"}', truncated: false } }],
  ] satisfies [string, Partial<ShellRunResult>][])('reports %s without changing bindings or the completed tool result', async (_label, overrides) => {
    const f = await fixture()
    f.execute.mockResolvedValue(execution(async () => output(overrides)))
    f.emit()
    await vi.waitFor(() => { expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('PR reference lookup failed')) })
    expect(f.records()).toEqual([])
    expect(f.result.isError).toBe(false)
  })

  it('reports a shell preparation rejection that is not an Error', async () => {
    const f = await fixture()
    f.execute.mockRejectedValue('unavailable')
    f.emit()
    await vi.waitFor(() => { expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('unavailable')) })
    expect(f.records()).toEqual([])
  })

  it.each(['caller', 'service'] as const)('joins pending preparation after %s cancellation and ignores its late result', async (owner) => {
    const f = await fixture()
    const pending = Promise.withResolvers<ShellExecution>()
    const started = Promise.withResolvers<ShellExecSpec>()
    releases.push(() => { pending.resolve(execution(async () => output())) })
    f.execute.mockImplementation((spec) => { started.resolve(spec); return pending.promise })
    f.emit()
    const spec = await started.promise
    const aborted = Promise.withResolvers<undefined>()
    spec.signal!.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    if (owner === 'caller') f.controller.abort()
    let disposed = false
    const disposal = f.service.dispose().then(() => { disposed = true })
    await aborted.promise
    expect(disposed).toBe(false)
    pending.resolve(execution(async () => output()))
    await disposal
    expect(f.records()).toEqual([])
    expect(f.warn).not.toHaveBeenCalled()
  })

  it('joins a cancelled preparation rejection without warning', async () => {
    const f = await fixture()
    const pending = Promise.withResolvers<ShellExecution>()
    const started = Promise.withResolvers<undefined>()
    releases.push(() => { pending.resolve(execution(async () => output())) })
    f.execute.mockImplementation(() => { started.resolve(undefined); return pending.promise })
    f.emit()
    await started.promise
    f.controller.abort()
    pending.reject(new Error('cancelled during preparation'))
    await f.service.dispose()
    expect(f.records()).toEqual([])
    expect(f.warn).not.toHaveBeenCalled()
  })

  it('skips unsupported, unsuccessful, already identified, or cancelled calls', async () => {
    const f = await fixture()
    f.emit({ ...f.exec, name: 'pwsh' })
    const { agent: _agent, ...withoutAgent } = f.exec
    f.emit(withoutAgent)
    f.emit(f.exec, { isError: true, error: { message: 'failed' }, content: [] })
    f.emit({ ...f.exec, arguments: {} })
    f.emit(f.exec, { isError: false, value: { kind: 'background' }, content: [] })
    f.emit({ ...f.exec, arguments: { command: 'gh pr view 9' } }, { ...f.result, content: [{ type: 'reasoning', text: 'thinking' }] })
    f.emit({ ...f.exec, arguments: { command: 'gh pr view 9 -R fake.test/octo/demo' } })
    f.emit(f.exec, { ...f.result, content: [{ type: 'text', text: JSON.stringify({ url: pullUrl(9) }) }] })
    f.controller.abort()
    f.emit()
    await f.service.dispose()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.records()).toEqual([])
    expect(f.warn).not.toHaveBeenCalled()
  })

  describe('inside a PTC program', () => {
    /** A `run_code` root call and nested `bash` calls whose run-scoped signal aborts when the program settles. */
    function program(f: Awaited<ReturnType<typeof fixture>>) {
      const rootController = new AbortController()
      const root: ToolExecution = {
        name: 'run_code', agent: f.agent,
        callId: brandString<ToolCallId>('program'), rootCallId: brandString<ToolCallId>('program'), token: Symbol('program') as ToolExecutionToken,
        arguments: { code: 'await tools.bash({ command })', description: 'Run it' }, signal: rootController.signal,
      }
      const run = new AbortController()
      const nested = (n: number, command: string, cwd = process.cwd()): [ToolExecution, ToolExecutionResult] => [{
        ...f.exec,
        callId: brandString<ToolCallId>(`program:ptc:${n}`), rootCallId: root.callId, token: Symbol(`nested ${n}`) as ToolExecutionToken,
        parent: root.token, arguments: { command, description: 'View it' }, signal: run.signal,
      }, { ...f.result, value: { kind: 'foreground', cwd, exitCode: 0, signal: null, timedOut: false, aborted: false } }]
      const settle = (outcome: ToolExecutionResult = { isError: false, value: null, content: [{ type: 'text', text: 'done' }] }) => {
        run.abort(new Error('run_code settled'))
        f.emit(root, outcome)
      }
      return { root, rootController, nested, settle }
    }

    it('looks up after the root call settles, in each call\'s shell world, even when the program fails', async () => {
      const f = await fixture()
      const p = program(f)
      const resolve = vi.spyOn(f.ctx.shell, 'resolve')
      const [first, firstResult] = p.nested(1, 'gh pr view 9 -R octo/demo --json number', '/tmp/first')
      const [second, secondResult] = p.nested(2, 'gh pr view 7 --repo octo/other', '/tmp/second')
      f.emit(first, firstResult)
      f.emit(second, secondResult)
      expect(f.execute).not.toHaveBeenCalled()

      p.settle({ isError: true, error: { message: 'code run failed' }, content: [] })
      await vi.waitFor(() => { expect(f.execute).toHaveBeenCalledTimes(2) })
      expect(resolve.mock.calls.map(([request]) => [request.command, request.workdir, request.dshEnv])).toEqual([
        ['env gh pr view 9 --repo octo/demo --json url', '/tmp/first', f.ctx.shellEnv.collect(first)],
        ['env gh pr view 7 --repo octo/other --json url', '/tmp/second', f.ctx.shellEnv.collect(second)],
      ])
      expect(resolve.mock.calls.every(([request]) => request.signal?.aborted === false)).toBe(true)
      await vi.waitFor(() => { expect(f.records()).toEqual([{ action: 'reference', url: pullUrl(9) }]) })
      expect(f.warn).not.toHaveBeenCalled()
    })

    it('carries lookups through every enclosing call to the root call', async () => {
      const f = await fixture()
      const p = program(f)
      const [inner, innerResult] = p.nested(1, 'gh pr view 9 -R octo/demo')
      const middle: ToolExecution = { ...p.root, name: 'cua_run_code', callId: brandString<ToolCallId>('program:ptc:2'), token: Symbol('middle') as ToolExecutionToken, parent: p.root.token }
      f.emit({ ...inner, parent: middle.token }, innerResult)
      f.emit(middle, { isError: false, value: null, content: [] })
      expect(f.execute).not.toHaveBeenCalled()

      p.settle()
      await vi.waitFor(() => { expect(f.records()).toEqual([{ action: 'reference', url: pullUrl(9) }]) })
    })

    it('continues with the next lookup after one fails', async () => {
      const f = await fixture()
      const p = program(f)
      f.execute.mockResolvedValueOnce(execution(async () => output({ exitCode: 1 })))
      for (const [call, outcome] of [p.nested(1, 'gh pr view 8 -R octo/demo'), p.nested(2, 'gh pr view 9 -R octo/demo')]) f.emit(call, outcome)
      p.settle()

      await vi.waitFor(() => { expect(f.records()).toEqual([{ action: 'reference', url: pullUrl(9) }]) })
      expect(f.warn).toHaveBeenCalledTimes(1)
      expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('PR reference lookup failed'))
    })

    it('drops queued lookups when the root call is cancelled, and skips calls whose output names their own URL', async () => {
      const f = await fixture()
      const p = program(f)
      f.emit(...p.nested(1, 'gh pr view 9 -R octo/demo'))
      const [printed, printedResult] = p.nested(2, 'gh pr view 7 -R octo/demo --json url')
      f.emit(printed, { ...printedResult, content: [{ type: 'text', text: JSON.stringify({ url: pullUrl(7) }) }] })
      p.rootController.abort()
      p.settle()
      await f.service.dispose()

      expect(f.execute).not.toHaveBeenCalled()
      expect(f.records()).toEqual([])
      expect(f.warn).not.toHaveBeenCalled()
    })
  })
})
