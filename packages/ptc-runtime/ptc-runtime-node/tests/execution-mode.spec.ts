import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { expect, it } from 'vitest'
import NodeRuntime from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { mountRuntime } from './setup.ts'
import { resolvePersistentExecution } from '../src/configuration.ts'

it.each([undefined, 'function-body', 'repl', 'script'] as const)('loads retained execution selected from %s syntax', async (programFormat) => {
  const { runtime } = await mountRuntime(new Context(), resolvePersistentExecution(programFormat))
  expect(runtime.retainsState).toBe(true)
  expect(runtime.programFormat).toBe(programFormat === 'script' ? 'script' : 'repl')
})

it.each<Config>([{}, { executionMode: 'per-call' }])('starts fresh state for each call with configuration %j', async (config) => {
  const { runtime } = await mountRuntime(new Context(), config)
  const stateOwner = {}
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner }))
  expect(runtime.programFormat).toBe('function-body')
  expect(runtime.sandboxMode).toBe('danger-full-access')
  expect((await run('globalThis.retained = 17; return retained;')).value).toBe(17)
  expect((await run('return typeof retained;')).value).toBe('undefined')
  await runtime.release(stateOwner)
})

it.each(['in-memory', 'durable', 'fresh-process', 'persistent-repl'])('rejects unsupported execution mode %s at configuration parsing', (executionMode) => {
  expect(() => z.resolve({ executionMode }, NodeRuntime.Config, {})).toThrow()
})

it('clears retained state when a provider is reloaded with another execution mode', async () => {
  const ctx = new Context()
  const owner = {}
  const { runtime: memory, fiber: memoryFiber } = await mountRuntime(ctx, { executionMode: 'persistent-in-memory' })
  const first = await memory.run(memory.resolve({ program: 'let retained = 17;', bindings: [], stateOwner: owner }))
  expect(first.error).toBeUndefined()
  expect(memory.programFormat).toBe('repl')
  expect(memory.sandboxMode).toBe('danger-full-access')
  await memoryFiber.dispose()
  const { runtime: perCall, fiber: perCallFiber } = await mountRuntime(ctx, { executionMode: 'per-call' })
  expect(perCall.programFormat).toBe('function-body')
  expect(perCall.sandboxMode).toBe('danger-full-access')
  expect((await perCall.run(perCall.resolve({ program: 'return typeof retained;', bindings: [], stateOwner: owner }))).value).toBe('undefined')
  await perCallFiber.dispose()
  const { runtime: resumed } = await mountRuntime(ctx, { executionMode: 'persistent-in-memory' })
  expect((await resumed.run(resumed.resolve({ program: 'typeof retained', bindings: [], stateOwner: owner }))).value).toBe('undefined')
})

it.each<NonNullable<Config['executionMode']>>(['per-call', 'persistent-in-memory', 'vm-script'])('resolves omitted cwd from the configured workspace in %s mode', async (executionMode) => {
  const workspaceRoot = join(process.cwd(), 'configured-workspace')
  const { runtime } = await mountRuntime(new Context(), { executionMode }, { workspaceRoot })
  expect(runtime.resolve({ program: '', bindings: [] }).cwd).toBe(workspaceRoot)
  expect(runtime.resolve({ program: '', bindings: [], cwd: process.cwd() }).cwd).toBe(process.cwd())
})

it.each(['per-call', 'persistent-in-memory'] as const)('rejects Script retention with %s syntax', async (executionMode) => {
  await expect(mountRuntime(new Context(), { executionMode, scriptPersistence: true })).rejects.toThrow('scriptPersistence')
})

it.each([false, true])('advertises Script syntax and its selected retention %s', async (scriptPersistence) => {
  const { runtime } = await mountRuntime(new Context(), { executionMode: 'vm-script', scriptPersistence })
  expect(runtime.programFormat).toBe('script')
  expect(runtime.retainsState).toBe(scriptPersistence)
  expect(runtime.executionInstructions).toContain('The final expression is awaited if it is a Promise')
  expect(runtime.executionInstructions).toContain('uncaught callback exception or unhandled rejection terminates the process')
  expect(runtime.executionInstructions).toContain('instanceof Array or Error may be false')
  expect(runtime.executionInstructions.includes('clears its variables')).toBe(scriptPersistence)
  expect(runtime.executionInstructions.includes('permanently uninitialized')).toBe(scriptPersistence)
  expect(runtime.executionInstructions.includes('Each call runs in a fresh Node process')).toBe(!scriptPersistence)
  const stateOwner = {}
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner }))
  expect(await run('let retained: number = 17; retained')).toMatchObject({ logs: [], value: 17 })
  expect(await run('typeof retained')).toMatchObject({ value: scriptPersistence ? 'number' : 'undefined' })
  await runtime.release(stateOwner)
  expect(await run('typeof retained')).toMatchObject({ value: 'undefined' })
})
