/** Agent activity model: a hosted session's turns, segments, statuses and `im/activity` emissions. */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, LlmAttemptId, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { ACTIVITY_PREVIEW_CHARS } from '../src/activity.ts'
import {
  BareActivity, blocked, bootActivity, call, failing, finish, hostedRecord, parts, script, text,
  type ActivityHarness,
} from './support/activity-harness.ts'
import { cleanRoots } from './support/sessions-harness.ts'

const open: ActivityHarness[] = []

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

afterAll(async () => {
  await cleanRoots()
})

/** Boot one activity harness and remember it for teardown. */
async function booted(spec: Parameters<typeof bootActivity>[0] = {}): Promise<ActivityHarness> {
  const harness = await bootActivity(spec)
  open.push(harness)
  return harness
}

/** One `assistant/assistant-stream` chunk frame of the first attempt. */
function chunk(index: number, value: StreamChunk, time = index + 1): AssistantStreamFrame {
  return { type: 'chunk', attemptId: LlmAttemptId('a1'), revision: 1, index, time, chunk: value }
}

describe('ImActivity segments', () => {
  it('turns a reasoning step with two tool calls and the answer into segments', async () => {
    const harness = await booted({ spec: { output: 'probe' } })
    script(harness, [
      [
        ...parts(0, 'reasoning', ['thinking ', 'it over']),
        ...call(1, 'c1', 'echo', '{"text":"one"}'),
        ...call(2, 'c2', 'echo', '{"text":"two"}'),
        finish('tool-calls'),
      ],
      [...parts(0, 'text', ['all ', 'done']), finish('stop')],
    ])

    await harness.turn('please look')

    const activity = harness.tracker.current(harness.record.sessionId)!
    expect(activity.turn).toBe(1)
    expect(activity.status).toBe('done')
    expect(activity.session.sessionId).toBe(harness.record.sessionId)
    expect(activity.trigger).toBe(harness.trigger)
    expect(activity.segments).toEqual([
      { kind: 'reasoning', text: 'thinking it over' },
      { kind: 'tool', callId: 'c1', name: 'echo', args: '{"text":"one"}', status: 'done', result: 'one' },
      { kind: 'tool', callId: 'c2', name: 'echo', args: '{"text":"two"}', status: 'done', result: 'two' },
      { kind: 'text', text: 'all done' },
    ])
    expect(harness.tracker.running(harness.record.sessionId)).toBe(false)
    // One announcement per turn, then its changes, closing with exactly one `end`.
    expect(harness.emitted.filter(entry => entry.change === 'start')).toHaveLength(1)
    expect(harness.emitted.filter(entry => entry.change === 'end')).toHaveLength(1)
    expect(harness.emitted.at(-1)?.activity.status).toBe('done')
  })

  it('settles a failing tool as error and bounds its preview text', async () => {
    const harness = await booted()
    const long = 'x'.repeat(ACTIVITY_PREVIEW_CHARS + 50)
    script(harness, [
      [...call(0, 'c1', 'boom', `{"text":"${long}"}`), ...call(1, 'c2', 'echo', `{"text":"${long}"}`), finish('tool-calls')],
      [...text(0, 'sorry'), finish('stop')],
    ])

    await harness.turn()

    const segments = harness.tracker.current(harness.record.sessionId)!.segments
    expect(segments).toHaveLength(3)
    const [failed, truncated] = segments as [Extract<typeof segments[number], { kind: 'tool' }>,
      Extract<typeof segments[number], { kind: 'tool' }>]
    expect(failed.status).toBe('error')
    expect(failed.result).toMatch(/boom failed/)
    expect(failed.args).toHaveLength(ACTIVITY_PREVIEW_CHARS + 1)
    expect(failed.args.endsWith('…')).toBe(true)
    expect(truncated.status).toBe('done')
    expect(truncated.result).toHaveLength(ACTIVITY_PREVIEW_CHARS + 1)
  })

  it('reports a cancelled turn and an errored turn', async () => {
    const cancelled = await booted()
    const entered = Promise.withResolvers<undefined>()
    script(cancelled, [blocked(entered)])
    const turn = cancelled.turn()
    await entered.promise
    expect(cancelled.tracker.running(cancelled.record.sessionId)).toBe(true)
    await cancelled.host.stop(cancelled.record.sessionId)
    await turn
    expect(cancelled.tracker.current(cancelled.record.sessionId)?.status).toBe('cancelled')
    expect(cancelled.tracker.running(cancelled.record.sessionId)).toBe(false)

    const errored = await booted()
    script(errored, [failing('model offline')])
    await errored.turn()
    const activity = errored.tracker.current(errored.record.sessionId)!
    expect(activity.status).toBe('error')
    expect(activity.error).toMatch(/model offline/)
  })
})

describe('ImActivity edges', () => {
  it('ignores every event of a session that is not hosted', async () => {
    const bare = new BareActivity(hostedRecord(), false)
    const id = bare.record.sessionId
    bare.log({ type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } })
    bare.log({
      type: 'tool/call', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'echo', arguments: '{}' },
    })
    bare.log({
      type: 'tool/result', surfaceOp: 'append', seq: SessionSeq(3), time: 3,
      data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('c1'), content: [], isError: false }) },
    })
    bare.frame(chunk(0, { type: 'text-delta', index: 0, text: 'ignored' }))
    bare.frame({ type: 'start', attemptId: LlmAttemptId('a2'), revision: 1, turn: 1, step: 1 })

    expect(bare.emitted).toEqual([])
    expect(bare.tracker.current(id)).toBeUndefined()
    expect(bare.tracker.running(id)).toBe(false)
    await bare.close()
  })

  it('collects live frames, drops empty deltas and settles a superseded turn', async () => {
    const bare = new BareActivity()
    const id = bare.record.sessionId
    // A turn without a trigger publishes no trigger.
    bare.trigger = undefined
    // A chunk before any turn opens nothing.
    bare.frame(chunk(0, { type: 'text-delta', index: 0, text: 'early' }))
    expect(bare.tracker.current(id)).toBeUndefined()

    bare.frame({ type: 'start', attemptId: LlmAttemptId('a1'), revision: 1, turn: 1, step: 1 })
    bare.frame(chunk(1, { type: 'block-start', index: 1, blockType: 'text' }))
    bare.frame(chunk(2, { type: 'text-delta', index: 1, text: '' }))
    bare.frame(chunk(3, { type: 'text-delta', index: 1, text: 'hi' }))
    bare.frame(chunk(4, { type: 'reasoning-delta', index: 2, text: 'then' }))
    expect(bare.tracker.current(id)).toMatchObject({
      turn: 1, status: 'running', segments: [{ kind: 'text', text: 'hi' }, { kind: 'reasoning', text: 'then' }],
    })
    expect(bare.tracker.current(id)).not.toHaveProperty('trigger')

    // A turn end of another turn does not settle this one.
    bare.log({ type: 'turn/end', seq: SessionSeq(4), time: 4, data: { turn: 7, reason: { kind: 'completed' } } })
    expect(bare.tracker.current(id)?.status).toBe('running')

    // The next turn closes the previous one, which never reported its end.
    bare.log({ type: 'turn/start', seq: SessionSeq(5), time: 5, data: { turn: 2 } })
    expect(bare.tracker.current(id)).toMatchObject({ turn: 2, status: 'running', segments: [] })
    expect(bare.emitted.map(entry => entry.change)).toEqual(['start', 'delta', 'delta', 'end', 'start'])

    // A settled turn ignores another end.
    bare.log({
      type: 'turn/end', seq: SessionSeq(6), time: 6, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    expect(bare.tracker.current(id)?.status).toBe('cancelled')
    bare.log({ type: 'turn/end', seq: SessionSeq(7), time: 7, data: { turn: 2, reason: { kind: 'completed' } } })
    expect(bare.tracker.current(id)?.status).toBe('cancelled')
    await bare.close()
  })

  it('settles only a known tool call and keeps the text blocks of its result', async () => {
    const bare = new BareActivity()
    const id = bare.record.sessionId
    bare.log({ type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } })
    bare.log({
      type: 'tool/call', seq: SessionSeq(2), time: 2,
      data: { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'echo', arguments: '{"text":"one"}' },
    })
    // A result of a call this turn never saw changes nothing.
    bare.log({
      type: 'tool/result', surfaceOp: 'append', seq: SessionSeq(3), time: 3,
      data: {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId: ToolCallId('other'), content: [{ type: 'text', text: 'no' }], isError: false }),
      },
    })
    expect(bare.tracker.current(id)?.segments).toEqual([
      { kind: 'tool', callId: 'c1', name: 'echo', args: '{"text":"one"}', status: 'running' },
    ])

    // Non-text result blocks contribute no preview text.
    bare.log({
      type: 'tool/result', surfaceOp: 'append', seq: SessionSeq(4), time: 4,
      data: {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('c1'),
          content: [{
            type: 'image',
            attachment: { attachmentId: AttachmentId('img-3'), mediaType: 'image/png', bytes: 12, width: 1, height: 1 },
          }],
          isError: false,
        }),
      },
    })
    expect(bare.tracker.current(id)?.segments).toEqual([
      { kind: 'tool', callId: 'c1', name: 'echo', args: '{"text":"one"}', status: 'done', result: '' },
    ])
    await bare.close()
  })

  it('closes a turn on idle, records the failure of the current turn and forgets a disposed session', async () => {
    const bare = new BareActivity()
    const id = bare.record.sessionId
    bare.error(2, new Error('stale turn'))
    bare.log({ type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } })
    bare.error(1, 'string failure')
    bare.status('running')
    expect(bare.tracker.current(id)?.status).toBe('running')
    bare.status('idle')
    expect(bare.tracker.current(id)?.status).toBe('done')

    bare.disposed()
    expect(bare.tracker.current(id)).toBeUndefined()

    // Without an agent/error, the turn end's own failure text is kept.
    const ended = new BareActivity()
    ended.log({ type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } })
    ended.log({
      type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'error', error: { message: 'model died', code: 'X' } } },
    })
    expect(ended.tracker.current(ended.record.sessionId)).toMatchObject({ status: 'error', error: 'model died' })
    await ended.close()
    await bare.close()
  })
})
