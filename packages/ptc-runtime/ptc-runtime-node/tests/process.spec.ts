import { spawn } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Duplex } from 'node:stream'
import { expect, it, onTestFinished } from 'vitest'
import { createProcessRpc } from '../src/rpc.ts'
import type { HostMethods, ProgramMethods } from '../src/protocol.ts'
import { decodePtcJsonWire, encodePtcJsonWire } from '../src/json-wire.ts'

it.each(['awaited', 'unawaited', 'unawaited script'] as const)('boots an unbuilt source closure outside the workspace with %s tool calls', async (scenario) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-source-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  for (const file of ['process.ts', 'bootstrap.ts', 'rpc.ts', 'json-wire.ts', 'output-json.ts', 'protocol.ts', 'environment.ts']) {
    await copyFile(new URL(`../src/${file}`, import.meta.url), join(directory, file))
  }
  for (const name of ['evaluators', 'imports']) {
    await cp(new URL(`../src/${name}/`, import.meta.url), join(directory, name), { recursive: true })
  }
  await mkdir(join(directory, 'node_modules'))
  for (const name of ['acorn', 'acorn-walk']) {
    await cp(dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`))), join(directory, 'node_modules', name), { recursive: true })
  }
  await cp(dirname(dirname(fileURLToPath(import.meta.resolve('birpc')))), join(directory, 'node_modules/birpc'), { recursive: true })
  const source = `import {Socket} from 'node:net';import {runNodeMain} from ${JSON.stringify(pathToFileURL(join(directory, 'process.ts')).href)};await runNodeMain(new Socket({fd:7,readable:true,writable:true}),100000,process);`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { PLACEHOLDER_SECRET: 'fixture-only' },
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'overlapped'],
  })
  let stderr = ''
  const logs: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const finished = new Promise<number | null>((resolve) => { child.once('close', resolve) })
  const completed = Promise.withResolvers<unknown>()
  child.once('error', (error) => { completed.reject(error) })
  child.once('exit', (code) => { if (code !== 0) completed.reject(new Error(`child exit ${code}: ${stderr}`)) })
  const control = Array.from(child.stdio)[7]
  if (!(control instanceof Duplex)) { child.kill(); await finished; throw new Error('missing child control channel') }
  const channel = createProcessRpc<ProgramMethods, HostMethods>(control, 100_000, {
    ready() {
      void channel.run(directory, {
        code: scenario === 'awaited' ? 'const answer = await tools.echo({ n: 21 }); return { answer, env: { ...process.env } }'
          : 'tools.echo({ n: 21 }); setImmediate(() => tools.echo({ n: 21 })); ' + (scenario === 'unawaited script' ? '42' : 'return 42'),
        retainsState: false,
        programFormat: scenario === 'unawaited script' ? 'script' : 'function-body',
        namespaces: [{ global: 'tools', names: ['echo'], errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }],
        maxOutputBytes: 10_000,
      }).then((result) => {
        if (result.error) completed.reject(new Error(result.error.message))
        else completed.resolve(decodePtcJsonWire(result.value))
      }, (error: unknown) => { completed.reject(error) })
    },
    async initialized() {},
    async invoke(_global, _name, args) {
      expect(decodePtcJsonWire(args)).toEqual({ n: 21 })
      return scenario === 'awaited' ? encodePtcJsonWire(42) : await new Promise<never>(() => {})
    },
    log(text) { logs.push(text) },
    image() {},
    outputLimit() {},
  }, [], (error) => { completed.reject(error) })
  onTestFinished(async () => { channel.$close(); child.kill(); await finished })
  expect(await completed.promise).toEqual(scenario === 'awaited' ? { answer: 42, env: {} } : 42)
  channel.$close()
  expect(await finished).toBe(0)
  expect(stderr).toBe('')
  expect(logs).toEqual([])
})
