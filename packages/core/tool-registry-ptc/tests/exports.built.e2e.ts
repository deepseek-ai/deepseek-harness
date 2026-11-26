/** The published entry exports PTC registries that share configuration and error identities with the plugin. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const entryBundle = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const execFileAsync = promisify(execFile)
const probe = String.raw`
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as ptc from '@deepseek-ai/dsh-tool-registry-ptc'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { NativeToolRegistry } from '@deepseek-ai/dsh-tools/pipeline'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

await assert.rejects(import('@deepseek-ai/dsh-tool-registry-ptc/run-code'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
assert.equal(Object.hasOwn(ptc, 'createRunCodeTool'), false)
assert.equal(Object.hasOwn(ptc, 'jsonSchemaToPy'), false)
assert.equal(Object.hasOwn(ptc, 'renderToolsSdkPy'), false)
assert.equal(ptc.PtcToolRegistry.Config, ptc.Config)
const ctx = new Context()
try {
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  ctx.tools.setRoot(new NativeToolRegistry())
  const runtime = {
    language: 'typescript', programFormat: 'repl', retainsState: false,
    resolve(request) { return { ...request, cwd: process.cwd(), timeoutMs: 60000 } },
    async run() { return { output: [], error: { kind: 'exception', message: 'probe failure' } } },
  }
  const capability = defineTool({
    name: 'private_probe', description: 'Probe private binding.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'private result' },
  })
  const programs = new ptc.PtcToolRegistry(ctx, { name: 'program_probe', description: 'Run the probe program.', runtime })
  programs.register(capability)
  const definition = programs.get('program_probe')
  assert.deepEqual(programs.getAll(), [definition])
  assert.equal(programs.get('private_probe'), undefined)
  const execution = {
    name: 'program_probe', callId: 'probe', rootCallId: 'probe', token: Symbol('probe'),
    signal: new AbortController().signal, deferContext() {}, concludeTurn() {},
  }
  await assert.rejects(definition.execute({ code: 'probe', description: 'Check shared error identity' }, execution),
    error => error instanceof ptc.CodeRunFailedError && error.code === 'CODE_RUN_FAILED')
  runtime.run = async () => ({ output: [], outputTruncated: true })
  assert.deepEqual(await definition.execute({ code: 'probe', description: 'Check successful truncated output' }, execution),
    { logs: [], outputTruncated: true })
  runtime.run = async (spec) => {
    assert.deepEqual(Object.keys(spec.bindings[0].functions), ['private_probe'])
    assert.equal(spec.discardCompletion, true)
    assert.equal(await spec.bindings[0].functions.private_probe({}), 'private result')
    return { output: [{ type: 'text', text: 'private result' }] }
  }
  const result = await definition.execute({ code: 'probe', description: 'Check the private binding' }, execution)
  assert.deepEqual(result, { logs: ['private result'] })
  // The private binding never reaches the deployment root's entries.
  assert.equal(ctx.tools.get('private_probe'), undefined)
} finally {
  await ctx.fiber.dispose()
}
console.log('shared program entries verified')
`

it.skipIf(!existsSync(entryBundle))('loads PTC registries with private bindings through published exports with shared errors', { retry: 0 }, async ({ signal }) => {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', probe], { cwd: packageRoot, signal })
  expect(stdout.trim()).toBe('shared program entries verified')
})
