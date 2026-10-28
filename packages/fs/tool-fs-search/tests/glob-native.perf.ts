/**
 * Threshold-free Native glob diagnostic over built runtime packages. The default
 * workload has 20,000 unrelated files and six matches. An explicit --workspace
 * selects a read-only real-workspace measurement; --plugin selects a built search
 * package revision. Setup, model generation, UI, and Session persistence are not timed.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'

const TARGET = 'packages/core/agent-loop/src'
const SAMPLES = 5
const DEPENDENCIES = 1_000
const FILES_PER_DEPENDENCY = 20
const MATCHES = 6

async function measure(): Promise<void> {
  const { values } = parseArgs({ options: { plugin: { type: 'string' }, workspace: { type: 'string' } } })
  const search = values.plugin === undefined
    ? ToolFsSearch
    : await import(pathToFileURL(resolve(values.plugin)).href) as typeof ToolFsSearch
  const temporary = values.workspace === undefined
  const root = values.workspace === undefined ? await mkdtemp(join(tmpdir(), 'dsh-native-glob-perf-')) : resolve(values.workspace)
  const ctx = new Context()
  try {
    if (temporary) {
      await mkdir(join(root, TARGET), { recursive: true })
      for (let index = 0; index < MATCHES; index++) {
        const file = join(root, TARGET, `file-${index}.ts`)
        await writeFile(file, '')
        await utimes(file, 1_000_000 + index, 1_000_000 + index)
      }
      for (let dependency = 0; dependency < DEPENDENCIES; dependency++) {
        const directory = join(root, 'node_modules', `dependency-${dependency}`, 'src')
        await mkdir(directory, { recursive: true })
        await Promise.all(Array.from({ length: FILES_PER_DEPENDENCY }, (_, index) => writeFile(join(directory, `file-${index}.ts`), '')))
      }
    }
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'native' } })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(search, { sampleOverCapGlobResults: true })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('native-glob-perf'), {}, { cwd: root })
    const samplesMs: number[] = []
    let outputHash: string | undefined
    for (let sample = 0; sample < SAMPLES; sample++) {
      const signal = AbortSignal.timeout(60_000)
      const start = performance.now()
      const batch = await ctx.tools.execute({
        agent,
        signal,
        calls: [{ type: 'tool-call', id: ToolCallId(`glob-${sample}`), name: 'glob', arguments: JSON.stringify({ pattern: `${TARGET}/*.ts` }) }],
      })
      const elapsed = performance.now() - start
      const result = batch.results[0]?.result
      assert(result !== undefined && !result.isError, 'Native glob must complete successfully')
      assert.equal(signal.aborted, false)
      if (temporary) assert.deepEqual(result.value, { root: '.', paths: Array.from({ length: MATCHES }, (_, index) => join(TARGET, `file-${index}.ts`)) })
      const digest = createHash('sha256').update(JSON.stringify([result.value, result.content, result.meta])).digest('hex')
      outputHash ??= digest
      assert.equal(digest, outputHash, 'Every sample must return the same value, text, and presentation metadata')
      samplesMs.push(elapsed)
      process.stdout.write(JSON.stringify({ sample: sample + 1, ms: elapsed }) + '\n')
    }
    process.stdout.write(JSON.stringify({
      node: process.version, platform: `${process.platform}-${process.arch}`, cpu: cpus()[0]?.model,
      workload: temporary ? { unrelatedFiles: DEPENDENCIES * FILES_PER_DEPENDENCY, matches: MATCHES } : 'explicit workspace',
      executor: 'native', samplesMs, medianMs: samplesMs.toSorted((a, b) => a - b)[Math.floor(SAMPLES / 2)], outputHash,
    }) + '\n')
  } finally {
    try { await ctx.fiber.dispose() } finally { if (temporary) await rm(root, { recursive: true, force: true }) }
  }
}

await measure()
