/** End-to-end SDK continuation through the built dsh sdk-minimal profile and real file tools. */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { PARENT_ID, resultText, WORKLOAD } from './workload.ts'

/** Parent-observed wall time, including profile launch and SDK shutdown. */
export interface ProfileReport {
  readonly totalMs: number
  readonly bootMs: number
  readonly turnsMs: number
  readonly closeMs: number
  readonly requests: number
  readonly toolCalls: number
}

async function run(root: string): Promise<ProfileReport> {
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(join(cwd, 'synthetic.txt'), resultText(0))
  const patch = join(root, 'profile.patch.yml')
  await writeFile(patch, [
    '- id: llm-deepseek', '  disabled: true',
    '- id: sessions', '  config:', '    root: ' + JSON.stringify(join(root, 'profile-sessions')), '    compression: zstd',
    '- insert:', '    - id: benchmark-model', '      name: ' + JSON.stringify(join(import.meta.dirname, 'profile-adapter.js')),
    '',
  ].join('\n'))
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    DSH_AGENTS_HOME: join(home, 'agents'),
  }
  const harness = new DeepSeekHarness({
    dshBin: join(import.meta.dirname, '..', '..', '..', 'apps', 'cli', 'lib', 'bin.js'),
    profile: 'sdk-minimal', dshHome: home, processCwd: cwd, cwd,
    provider: 'bench', model: 'bench', patches: [patch], env,
    initializeTimeoutMs: 15_000, requestTimeoutMs: 15_000,
  })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= harness.close()
  let expired = false
  const deadline = setTimeout(() => {
    expired = true
    // The awaited finally close below reports shutdown failures; this only requests cancellation.
    void close().catch(() => undefined)
  }, 40_000)
  let requests = 0
  let toolCalls = 0
  const start = performance.now()
  try {
    await harness.start()
    const booted = performance.now()
    for (let turn = 0; turn < WORKLOAD.profileTurns; turn++) {
      const result = await harness.run('Read the synthetic file ' + String(turn), { sessionId: PARENT_ID })
      requests += result.events.filter(event => event.type === 'assistant/message').length
      for (const event of result.events) {
        if (event.type !== 'tool/result') continue
        const result = event.data.message.content[0]
        if (result.isError || !result.content.some(block => block.type === 'text' && block.text.includes('export const synthetic = 42;'))) {
          throw new Error('profile benchmark did not read the synthetic file')
        }
        toolCalls++
      }
    }
    const turnsDone = performance.now()
    await close()
    const end = performance.now()
    if (expired || requests !== WORKLOAD.profileTurns * 2 || toolCalls !== WORKLOAD.profileTurns * WORKLOAD.toolsPerLiveTurn) {
      throw new Error('profile benchmark did not finish every model request and real tool call')
    }
    return { totalMs: end - start, bootMs: booted - start, turnsMs: turnsDone - booted, closeMs: end - turnsDone, requests, toolCalls }
  } finally {
    clearTimeout(deadline)
    await close()
  }
}

assertBuiltBenchmarkRuntime(import.meta.url, { '@deepseek-ai/dsh-sdk-client': import.meta.resolve('@deepseek-ai/dsh-sdk-client') })
const [root] = process.argv.slice(2)
if (root === undefined) throw new Error('usage: profile-continuation.worker.js <root>')
process.stdout.write(JSON.stringify(await run(root)) + '\n')
