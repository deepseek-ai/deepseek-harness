import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { createProgramEvaluator } from '../src/evaluators/index.ts'
import { mountRuntime } from './setup.ts'

it('reports a missing VM startup flag before accepting a Script handler', () => {
  expect(() => createProgramEvaluator('script', () => {}, () => ({ type: 'default' })))
    .toThrow('PTC importHandler requires the runner to start with --experimental-vm-modules')
})

async function customBootstrap(asyncDecisions = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ptc-import-runner-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const bootstrapPath = join(directory, 'runner.mjs')
  const subprocess = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess/package.json')))
  await writeFile(bootstrapPath, `
    import { openInheritedControlChannel } from ${JSON.stringify(pathToFileURL(join(subprocess, 'src/control.ts')).href)};
    import { runNodeMain } from ${JSON.stringify(new URL('../src/process.ts', import.meta.url).href)};
    class Counter { #count = 0; next() { return ++this.#count } }
    const exports = { Counter, counter: new Counter(), pid: process.pid };
    await runNodeMain(openInheritedControlChannel(), Number(process.argv[2]), process, 'function-body',
      ${asyncDecisions ? 'async ' : ''}({ specifier }) => specifier === 'runner:counter' ? { type: 'module', exports } : { type: 'default' });
  `)
  return bootstrapPath
}

it('intercepts a child ESM dependency and its later imports through an asynchronous runner handler', async () => {
  const bootstrapPath = await customBootstrap(true)
  const modulePath = join(dirname(bootstrapPath), 'dependency.mjs')
  await writeFile(modulePath, `
    import { counter, Counter } from 'runner:counter';
    export const first = () => [counter.next(), counter instanceof Counter];
    export const later = async () => (await import('runner:counter')).counter.next();
  `)
  const { runtime } = await mountRuntime(new Context(), { executionMode: 'vm-script', scriptPersistence: true,
    launch: { kind: 'node-script', executable: process.execPath, bootstrapPath } })
  const stateOwner = {}
  const first = await runtime.run(runtime.resolve({ program: `var dependency = await import(${JSON.stringify(pathToFileURL(modulePath).href)}); dependency.first()`, bindings: [], stateOwner }))
  expect(first.error).toBeUndefined()
  expect(first.value).toEqual([1, true])
  const later = await runtime.run(runtime.resolve({ program: 'await dependency.later()', bindings: [], stateOwner }))
  expect(later.error).toBeUndefined()
  expect(later.value).toBe(2)
})

it.each([
  { executionMode: 'per-call', scriptPersistence: false },
  { executionMode: 'vm-script', scriptPersistence: false },
  { executionMode: 'vm-script', scriptPersistence: true },
  { executionMode: 'persistent-in-memory', scriptPersistence: false, replScoped: false },
] as const)('runs imports inside the configured child in $executionMode with retention $scriptPersistence', async (mode) => {
  const bootstrapPath = await customBootstrap()
  const { runtime } = await mountRuntime(new Context(), { ...mode, launch: { kind: 'node-script', executable: process.execPath, bootstrapPath } })
  const stateOwner = {}
  const program = `${mode.executionMode === 'per-call' ? 'return ' : 'await '}(async () => {
    const { Counter, counter, pid } = await import('runner:counter');
    const { env } = await import('node:process');
    return { count: counter.next(), instance: counter instanceof Counter, child: pid !== ${process.pid}, env: Object.keys(env) };
  })()`
  for (let index = 0; index < 2; index++) {
    const result = await runtime.run(runtime.resolve({ program, bindings: [], stateOwner }))
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ count: mode.scriptPersistence || mode.executionMode === 'persistent-in-memory' ? index + 1 : 1,
      instance: true, child: true, env: [] })
  }
})

it.each(['function-body', 'repl'] as const)('intercepts %s imports without the VM startup flag', async (format) => {
  const evaluator = createProgramEvaluator(format, () => {}, () => ({ type: 'module', exports: { answer: 42 } }))
  onTestFinished(() => { evaluator.close() })
  const result = await new Promise<unknown>((resolve) => {
    evaluator.evaluate(`${format === 'function-body' ? 'return ' : ''}(await import('runner:answer')).answer`, resolve)
  })
  expect(result).toEqual({ ok: true, value: 42 })
})
