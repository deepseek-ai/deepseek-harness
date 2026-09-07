/** Compiled production Client fold for a reconnect during a long Assistant attempt. */
import { performance } from 'node:perf_hooks'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionAssistantStreamBaseline } from '@deepseek-ai/dsh-api-session-controller/types'
// The Client implementation has no plain-Node export; only this adapter is bundled.
import { ClientAssistantStream } from '../../packages/api/session-controller/src/client/sessions/assistant-stream.ts'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'

/** Measurements of replace() only; fixture construction and forced GC are excluded. */
export interface ReconnectReport {
  readonly deltas: number
  readonly records: number
  readonly entries: number
  readonly replaceMs: number
  readonly retainedMb: number
  readonly nextFrame: string | undefined
}

assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-llm/assistant-stream': import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'),
})
const deltas = 100000
const accumulator = new AssistantStreamAccumulator()
accumulator.push({ time: 1700000000000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
for (let index = 0; index < deltas; index++) {
  accumulator.push({ time: 1700000000001 + index, chunk: { type: 'reasoning-delta', index: 0, text: 'token ' } })
}
const attemptId = LlmAttemptId('synthetic-reconnect')
const nextIndex = deltas + 1
const baseline: SessionAssistantStreamBaseline = {
  revision: nextIndex + 1,
  activeAttempt: {
    attemptId, startedAfterSeq: -1, turn: 1, step: 1, nextIndex,
    stream: JSON.parse(JSON.stringify(accumulator.snapshot())) as NonNullable<SessionAssistantStreamBaseline['activeAttempt']>['stream'],
  },
}
if (globalThis.gc === undefined) throw new Error('reconnect benchmark requires --expose-gc')
globalThis.gc()
const before = process.memoryUsage().heapUsed
const client = new ClientAssistantStream()
const start = performance.now()
const visible = client.replace([], baseline)
const replaceMs = performance.now() - start
globalThis.gc()
const retainedMb = (process.memoryUsage().heapUsed - before) / 1048576
const next = client.acceptFrame({ type: 'chunk', attemptId, revision: nextIndex + 2, index: nextIndex, time: 1700000000001 + deltas, chunk: { type: 'reasoning-delta', index: 0, text: 'suffix' } })
const report: ReconnectReport = { deltas, records: baseline.activeAttempt!.stream.length, entries: visible.length, replaceMs, retainedMb, nextFrame: next?.type }
process.stdout.write(JSON.stringify(report) + '\n')
