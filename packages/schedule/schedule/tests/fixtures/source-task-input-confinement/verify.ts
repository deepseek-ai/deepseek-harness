/** Persisted Source delivery must retain the destination's filesystem policy at tool execution. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-agent'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Result of the causally matched real write and its independent filesystem observation. */
export interface SourceWriteObservation {
  isError: boolean | undefined
  errorName: string | undefined
  errorCode: string | undefined
  fileExists: boolean
}

const savedSchedule = z.object({
  unit: z.object({ name: z.literal('schedule') }),
  tables: z.object({
    tasks: z.object({
      'schedule-source-snapshot': z.object({
        deliveryHistory: z.object({
          records: z.array(z.object({ messageId: z.string(), targetSessionId: z.string() })),
        }),
      }),
    }),
  }),
})

/**
 * Assert durable Source delivery and call/result causality before examining either policy outcome.
 * @param log - Harvested primary Session log from the completed profile process.
 * @param sessionId - Primary Session identity from its persisted header.
 * @param cwd - Isolated workspace, still owned by runLoaderSmoke.
 * @returns The real write result and independent file-existence observation.
 */
export async function observeSourceWrite(log: string, sessionId: SessionId, cwd: string): Promise<SourceWriteObservation> {
  const events = parseSessionLog(log)
  const sourceMessages = events.filter(event => event.type === 'user/message')
    .filter(event => event.data.source.kind === 'schedule')
  assert.equal(sourceMessages.length, 1, 'one Source candidate must reach the model')
  const sourceMessage = sourceMessages[0]!
  assert.ok(sourceMessage.data.content.some(block => block.type === 'text' && block.text.includes('source_input_json:')))

  const saved = savedSchedule.parse(JSON.parse(await readFile(join(cwd, '.dsh/source-confinement-storage/schedule.json'), 'utf8')))
  const receipts = saved.tables.tasks['schedule-source-snapshot'].deliveryHistory.records
  assert.deepEqual(receipts, [{ messageId: sourceMessage.data.id, targetSessionId: sessionId }], 'Source receipt must be durable')
  const insertion = events.find(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => message.id === sourceMessage.data.id))
  assert.ok(insertion, 'Source receipt must identify a persisted inbox insertion')

  const calls = events.filter(event => event.type === 'tool/call')
  assert.equal(calls.length, 1, 'the Source candidate must trigger exactly one executor call')
  const call = calls[0]!
  assert.equal(call.data.name, 'write')
  assert.deepEqual(JSON.parse(call.data.arguments), {
    file_path: 'source-confinement-sentinel.txt', content: 'Source write reached the filesystem.\n',
  })
  const results = events.filter(event => event.type === 'tool/result')
  assert.equal(results.length, 1, 'the write attempt must settle exactly once')
  const result = results[0]!
  assert.equal(result.data.message.toolCallId, call.data.callId)
  assert.ok(events.indexOf(insertion) < events.indexOf(sourceMessage))
  assert.ok(events.indexOf(sourceMessage) < events.indexOf(call))
  assert.ok(events.indexOf(call) < events.indexOf(result))
  return {
    isError: result.data.message.isError,
    errorName: result.data.error?.name,
    errorCode: result.data.error?.code,
    fileExists: existsSync(join(cwd, 'source-confinement-sentinel.txt')),
  }
}

/**
 * Require a filesystem-policy refusal rather than a schema, registration, or model-text failure.
 * @param observation - Outcome collected after all durable-delivery and causality assertions pass.
 */
export function assertSourceWriteDenied(observation: SourceWriteObservation): void {
  assert.deepEqual(observation, {
    isError: true, errorName: 'FsError', errorCode: 'FS_SANDBOX_DENIED', fileExists: false,
  }, 'Source-triggered write must be denied by the filesystem policy without creating a file')
}
