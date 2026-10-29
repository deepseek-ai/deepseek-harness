/** Public tool entries must share runtime identities without exporting test helpers from the plugin. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const pipelineBundle = fileURLToPath(new URL('../lib/pipeline.js', import.meta.url))
const execFileAsync = promisify(execFile)
const probe = String.raw`
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as tools from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'

assert.equal(Object.hasOwn(tools, 'defineContentToolFixture'), false)
assert.equal(Object.hasOwn(tools, 'executeToolFixture'), false)
assert.equal(Object.hasOwn(tools, 'executeModelToolFixture'), false)
await assert.rejects(import('@deepseek-ai/dsh-tools/testing'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
const ctx = new Context()
try {
  const cause = new Error('registry lookup failed')
  const pipeline = new ToolExecutionPipeline(ctx, { get() { throw cause } })
  assert.equal(typeof pipeline.prepare, 'function')
  await assert.rejects(executeToolBatch({
    calls: [{ type: 'tool-call', id: 'probe', name: 'probe', arguments: '{}' }],
    signal: new AbortController().signal,
  }, pipeline, () => 1), error => error instanceof tools.ToolBatchExecutionError && error.cause === cause)
  const definition = defineContentToolFixture({
    name: 'probe', description: 'probe', parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  })
  assert.equal(definition.name, 'probe')
} finally {
  await ctx.fiber.dispose()
}
console.log('shared tool entries verified')
`

it.skipIf(!existsSync(pipelineBundle))('shares batch failures and scheduler stages across built entries', { retry: 0 }, async ({ signal }) => {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', probe], { cwd: packageRoot, signal })
  expect(stdout.trim()).toBe('shared tool entries verified')
})
