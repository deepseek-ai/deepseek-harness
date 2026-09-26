import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ScheduleRuntime, MAX_TIMER_DELAY_MS } from '../src/runtime.ts'
import {
  createAfterScheduleRecord, createAtScheduleRecord, createDailyScheduleRecord, createEveryScheduleRecord, ScheduleId,
} from '../src/domain.ts'
import type { ScheduleTask } from '../src/storage.ts'
import { harness, agentFor } from './harness.ts'

const tests: Awaited<ReturnType<typeof harness>>[] = []
const runtimes: ScheduleRuntime[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00Z')) })
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.useRealTimers()
})
async function setup(tasks: ScheduleTask[]) {
  const test = await harness(); tests.push(test)
  const agent = agentFor(test.ctx)
  const followup = vi.fn<Agent['followup']>()
  agent.followup = followup
  test.resolve.mockResolvedValue({ agent })
  const commit = vi.fn(async (task: ScheduleTask) => {
    const index = tasks.findIndex(current => current.record.id === task.record.id)
    tasks[index] = task
  })
  const runtime = new ScheduleRuntime(test.ctx, () => tasks, work => work(), commit, { days: 30, records: 200 })
  runtimes.push(runtime)
  return { ...test, agent, followup, runtime, commit }
}
function task(record: ScheduleTask['record']): ScheduleTask {
  return { sessionId: SessionId('original'), record, status: 'active' }
}

it('seeds legacy history only from its actual receipt and appends through wall-clock rollback', async () => {
  const previous = {
    scheduledAt: '2026-09-15T00:00:00.000Z', deliveredAt: '2026-09-16T00:00:01.000Z',
    messageId: MessageId('actual-legacy-message'),
  }
  const record = createEveryScheduleRecord(
    ScheduleId('legacy-history'), 'Current prompt', 300, Date.now() - 300_000, 'Current prompt',
  )
  const original: ScheduleTask = { ...task(record), lastDelivery: previous }
  const tasks = [original]
  const test = await setup(tasks)
  test.flush.mockImplementationOnce(async () => { vi.setSystemTime(new Date('2026-09-15T23:59:59.000Z')) })
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(0)
  expect(original).toEqual({ ...task(record), lastDelivery: previous })
  expect(tasks[0]?.deliveryHistory).toEqual({ earlierRecordsUnavailable: true, earlierRecordsPruned: false, records: [previous, {
    scheduledAt: '2026-09-16T00:00:00.000Z', deliveredAt: '2026-09-15T23:59:59.000Z',
    messageId: test.followup.mock.calls[0]![0].id, prompt: 'Current prompt',
  }] })
  expect(tasks[0]?.deliveryHistory?.records[0]).not.toHaveProperty('prompt')
})

describe('Host Schedule timer', () => {
  it('restores the original Session and retains an ended one-shot with its flushed message receipt', async () => {
    const tasks = [task(createAfterScheduleRecord(ScheduleId('once'), 'Remember', 2, Date.now(), 'Remember'))]
    const test = await setup(tasks)
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(1999)
    expect(test.resolve).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(test.resolve).toHaveBeenCalledWith(SessionId('original'))
    expect(test.followup).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'schedule' } }))
    expect(test.flush).toHaveBeenCalled()
    expect(test.commit).toHaveBeenCalledTimes(1)
    expect(tasks).toEqual([{
      sessionId: SessionId('original'), status: 'inactive',
      record: createAfterScheduleRecord(ScheduleId('once'), 'Remember', 2, Date.now() - 2000, 'Remember'),
      deliveryHistory: { earlierRecordsUnavailable: true, earlierRecordsPruned: false, records: [{
        scheduledAt: '2026-09-16T00:00:02.000Z', deliveredAt: '2026-09-16T00:00:02.000Z',
        messageId: test.followup.mock.calls[0]![0].id, prompt: 'Remember',
      }] },
      lastDelivery: {
        scheduledAt: '2026-09-16T00:00:02.000Z', deliveredAt: '2026-09-16T00:00:02.000Z',
        messageId: test.followup.mock.calls[0]![0].id,
      },
    }])
    expect(vi.getTimerCount()).toBe(0)
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(test.followup).toHaveBeenCalledTimes(1)
  })

  it('delivers one latest recurring occurrence after downtime and retains the fixed-rate next target', async () => {
    const tasks = [task(createEveryScheduleRecord(ScheduleId('repeat'), 'Repeat', 300, Date.now() - 3_000_000, 'Repeat'))]
    const test = await setup(tasks)
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(tasks[0]).toMatchObject({
      status: 'active', record: { scheduledAt: '2026-09-16T00:05:00.000Z' },
      lastDelivery: {
        scheduledAt: '2026-09-16T00:00:00.000Z', deliveredAt: '2026-09-16T00:00:00.000Z',
        messageId: test.followup.mock.calls[0]![0].id,
      },
    })
    expect(test.commit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(test.followup).toHaveBeenCalledTimes(2)
    expect(tasks[0]?.lastDelivery).toEqual({
      scheduledAt: '2026-09-16T00:05:00.000Z', deliveredAt: '2026-09-16T00:05:00.000Z',
      messageId: test.followup.mock.calls[1]![0].id,
    })
  })

  it.each(['returned', 'rejected'] as const)('rearms a future target after clock rollback and %s restoration failure', async (mode) => {
    const start = Date.now()
    const tasks = [task(createAfterScheduleRecord(ScheduleId('rollback-failure'), 'Later', 2, start, 'Later'))]
    const test = await setup(tasks)
    const error = new RemoteError('session/not-found', 'Session unavailable', { sessionId: SessionId('original') })
    test.resolve.mockImplementationOnce(async () => {
      vi.setSystemTime(start)
      if (mode === 'rejected') throw error
      return { error }
    })
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.followup).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(test.resolve).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(tasks[0]?.status).toBe('inactive')
  })

  it('keeps an advanced task armed when another task in its batch cannot be persisted', async () => {
    const tasks = [
      task(createEveryScheduleRecord(ScheduleId('advanced'), 'Regular check', 300, Date.now() - 300_000, 'Regular check')),
      task(createDailyScheduleRecord(ScheduleId('uncommitted'), 'Daily check', {
        time: '00:00:00', time_zone: 'UTC',
      }, Date.now() - 1000, 'Daily check')),
    ]
    const test = await setup(tasks)
    test.commit.mockImplementationOnce(async (updated) => { tasks[0] = updated })
      .mockRejectedValueOnce(new Error('second task write failed'))
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(tasks[0]?.record.scheduledAt).toBe('2026-09-16T00:05:00.000Z')
    expect(tasks[1]?.record.scheduledAt).toBe('2026-09-16T00:00:00.000Z')
    expect(tasks[1]?.lastDelivery).toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(test.followup).toHaveBeenCalledTimes(2)
    expect(tasks[0]?.record.scheduledAt).toBe('2026-09-16T00:10:00.000Z')
    expect(tasks[1]?.record.scheduledAt).toBe('2026-09-17T00:00:00.000Z')
  })

  it('keeps the daily task identity and rule across two deliveries with distinct message receipts', async () => {
    const record = createDailyScheduleRecord(ScheduleId('daily'), 'Morning check', {
      time: '08:00:02', time_zone: 'Asia/Shanghai',
    }, Date.now(), 'Morning check')
    const tasks = [task(record)]
    const test = await setup(tasks)
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(1999)
    expect(test.followup).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    const firstMessage = test.followup.mock.calls[0]![0]
    expect(tasks).toEqual([{
      sessionId: SessionId('original'), status: 'active',
      record: { ...record, scheduledAt: '2026-09-17T00:00:02.000Z' },
      deliveryHistory: { earlierRecordsUnavailable: true, earlierRecordsPruned: false, records: [{
        scheduledAt: '2026-09-16T00:00:02.000Z', deliveredAt: '2026-09-16T00:00:02.000Z',
        messageId: firstMessage.id, prompt: 'Morning check',
      }] },
      lastDelivery: {
        scheduledAt: '2026-09-16T00:00:02.000Z', deliveredAt: '2026-09-16T00:00:02.000Z',
        messageId: firstMessage.id,
      },
    }])
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(test.followup).toHaveBeenCalledTimes(2)
    expect(test.resolve.mock.calls).toEqual([[SessionId('original')], [SessionId('original')]])
    const secondMessage = test.followup.mock.calls[1]![0]
    expect(secondMessage.id).not.toBe(firstMessage.id)
    expect(tasks).toEqual([{
      sessionId: SessionId('original'), status: 'active',
      record: { ...record, scheduledAt: '2026-09-18T00:00:02.000Z' },
      deliveryHistory: { earlierRecordsUnavailable: true, earlierRecordsPruned: false, records: [{
        scheduledAt: '2026-09-16T00:00:02.000Z', deliveredAt: '2026-09-16T00:00:02.000Z',
        messageId: firstMessage.id, prompt: 'Morning check',
      }, {
        scheduledAt: '2026-09-17T00:00:02.000Z', deliveredAt: '2026-09-17T00:00:02.000Z',
        messageId: secondMessage.id, prompt: 'Morning check',
      }] },
      lastDelivery: {
        scheduledAt: '2026-09-17T00:00:02.000Z', deliveredAt: '2026-09-17T00:00:02.000Z',
        messageId: secondMessage.id,
      },
    }])
    expect(test.commit).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed enqueue without a retry timer', async () => {
    const tasks = [task(createAfterScheduleRecord(ScheduleId('failed'), 'Retry on restart', 1, Date.now() - 2000, 'Retry on restart'))]
    const test = await setup(tasks)
    vi.mocked(test.followup).mockImplementation(() => { throw new Error('unavailable') })
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.commit).not.toHaveBeenCalled()
    expect(tasks).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(test.followup).toHaveBeenCalledTimes(1)
  })

  it('keeps the task when Session durability fails after enqueue', async () => {
    const tasks = [task(createAfterScheduleRecord(ScheduleId('uncertain'), 'Uncertain', 1, Date.now() - 2000, 'Uncertain'))]
    const test = await setup(tasks)
    test.flush.mockRejectedValue(new Error('disk failure'))
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(test.commit).not.toHaveBeenCalled()
    expect(tasks).toHaveLength(1)
  })

  it.each(['flush', 'commit'] as const)('preserves the previous daily target, status, and receipt when %s fails', async (failure) => {
    const record = createDailyScheduleRecord(ScheduleId('daily-failure'), 'Keep previous delivery', {
      time: '08:00:00', time_zone: 'Asia/Shanghai',
    }, Date.now() - 1000, 'Keep previous delivery')
    const original: ScheduleTask = {
      ...task(record),
      lastDelivery: {
        scheduledAt: '2026-09-15T00:00:00.000Z', deliveredAt: '2026-09-15T00:00:01.000Z',
        messageId: MessageId('previous-daily-message'),
      },
    }
    const records = [structuredClone(original)]
    const test = await setup(records)
    if (failure === 'flush') test.flush.mockRejectedValueOnce(new Error('Session disk failure'))
    else test.commit.mockRejectedValueOnce(new Error('Schedule disk failure'))
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(test.flush).toHaveBeenCalledTimes(1)
    expect(test.commit).toHaveBeenCalledTimes(failure === 'flush' ? 0 : 1)
    expect(records).toEqual([original])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(records).toEqual([original])
  })

  it('publishes a daily advance only after the Session flush completes', async () => {
    const record = createDailyScheduleRecord(ScheduleId('daily-flush'), 'Await persistence', {
      time: '08:00:00', time_zone: 'Asia/Shanghai',
    }, Date.now() - 1000, 'Await persistence')
    const records = [task(record)]
    const test = await setup(records)
    const entered = Promise.withResolvers<undefined>()
    const flushed = Promise.withResolvers<undefined>()
    test.flush.mockImplementationOnce(() => { entered.resolve(undefined); return flushed.promise })
    test.runtime.requestDrive()
    await entered.promise
    try {
      expect(test.followup).toHaveBeenCalledTimes(1)
      expect(test.commit).not.toHaveBeenCalled()
      expect(records).toEqual([task(record)])
      vi.setSystemTime(new Date('2026-09-16T00:00:03.000Z'))
    } finally {
      flushed.resolve(undefined)
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(records).toEqual([{
      ...task(record), record: { ...record, scheduledAt: '2026-09-17T00:00:00.000Z' },
      deliveryHistory: { earlierRecordsUnavailable: true, earlierRecordsPruned: false, records: [{
        scheduledAt: '2026-09-16T00:00:00.000Z', deliveredAt: '2026-09-16T00:00:03.000Z',
        messageId: test.followup.mock.calls[0]![0].id, prompt: 'Await persistence',
      }] },
      lastDelivery: {
        scheduledAt: '2026-09-16T00:00:00.000Z', deliveredAt: '2026-09-16T00:00:03.000Z',
        messageId: test.followup.mock.calls[0]![0].id,
      },
    }])
  })

  it('drains an in-flight resolution on disposal without enqueueing after stop', async () => {
    const tasks = [task(createAfterScheduleRecord(ScheduleId('stop'), 'Stopped', 1, Date.now() - 2000, 'Stopped'))]
    const test = await setup(tasks)
    const resolved = Promise.withResolvers<{ agent: typeof test.agent }>()
    test.resolve.mockReturnValue(resolved.promise)
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    const stopped = test.runtime.dispose()
    resolved.resolve({ agent: test.agent })
    await stopped
    expect(test.followup).not.toHaveBeenCalled()
  })

  it('segments long waits and cancels the timer on disposal', async () => {
    const tasks = [task(createAfterScheduleRecord(ScheduleId('long'), 'Long', 3_000_000, Date.now(), 'Long'))]
    const test = await setup(tasks)
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS)
    expect(test.resolve).not.toHaveBeenCalled()
    await test.runtime.dispose()
    await vi.advanceTimersByTimeAsync(3_000_000_000)
    expect(test.resolve).not.toHaveBeenCalled()
  })
})

describe('Schedule dispatch failures and concurrent changes', () => {
  it('batches same-Session recurring tasks once while keeping other Session obligations separate', async () => {
    const records: ScheduleTask[] = [
      task(createEveryScheduleRecord(ScheduleId('a'), 'First', 300, Date.now() - 900_000, 'First')),
      task(createEveryScheduleRecord(ScheduleId('b'), 'Second', 600, Date.now() - 1_860_000, 'Second')),
      { sessionId: SessionId('other'), status: 'active', record: createEveryScheduleRecord(ScheduleId('c'), 'Third', 300, Date.now() - 900_000, 'Third') },
      task(createAfterScheduleRecord(ScheduleId('future-a'), 'Later A', 10, Date.now(), 'Later A')),
      task(createAfterScheduleRecord(ScheduleId('future-b'), 'Later B', 20, Date.now(), 'Later B')),
    ]
    const test = await setup(records)
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.followup).toHaveBeenCalledTimes(2)
    expect(test.commit).toHaveBeenCalledTimes(3)
    expect(test.resolve.mock.calls.map(([id]) => id)).toEqual(['original', 'other'])
    const firstMessage = test.followup.mock.calls[0]?.[0]
    expect(JSON.stringify(firstMessage?.content)).toContain('First')
    expect(JSON.stringify(firstMessage?.content)).toContain('Second')
    expect(records.slice(0, 3).map(item => item.lastDelivery)).toEqual([
      { scheduledAt: '2026-09-16T00:00:00.000Z', deliveredAt: '2026-09-16T00:00:00.000Z', messageId: firstMessage!.id },
      { scheduledAt: '2026-09-15T23:59:00.000Z', deliveredAt: '2026-09-16T00:00:00.000Z', messageId: firstMessage!.id },
      { scheduledAt: '2026-09-16T00:00:00.000Z', deliveredAt: '2026-09-16T00:00:00.000Z', messageId: test.followup.mock.calls[1]![0].id },
    ])
    expect(test.followup.mock.calls[1]![0].id).not.toBe(firstMessage!.id)
    expect(records.map(item => item.record.scheduledAt)).toContain('2026-09-16T00:00:10.000Z')
  })

  it('batches daily and fixed-rate occurrences in one Session after downtime', async () => {
    const daily = createDailyScheduleRecord(ScheduleId('daily-batch'), 'Daily check', {
      time: '07:59:00', time_zone: 'Asia/Shanghai',
    }, Date.parse('2026-09-13T00:00:00.000Z'), 'Daily check')
    const every = createEveryScheduleRecord(
      ScheduleId('every-batch'), 'Interval check', 300, Date.now() - 900_000, 'Interval check',
    )
    const records = [task(daily), task(every)]
    const test = await setup(records)
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.resolve).toHaveBeenCalledTimes(1)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(test.flush).toHaveBeenCalledTimes(1)
    const message = test.followup.mock.calls[0]![0]
    expect(message.source).toEqual({ kind: 'schedule' })
    expect(JSON.stringify(message.content)).toContain('Daily check')
    expect(JSON.stringify(message.content)).toContain('Interval check')
    expect(records).toEqual([
      {
        sessionId: SessionId('original'), status: 'active',
        record: { ...daily, scheduledAt: '2026-09-16T23:59:00.000Z' },
        deliveryHistory: { earlierRecordsUnavailable: true, earlierRecordsPruned: false, records: [{
          scheduledAt: '2026-09-15T23:59:00.000Z', deliveredAt: '2026-09-16T00:00:00.000Z',
          messageId: message.id, prompt: 'Daily check',
        }] },
        lastDelivery: {
          scheduledAt: '2026-09-15T23:59:00.000Z', deliveredAt: '2026-09-16T00:00:00.000Z', messageId: message.id,
        },
      },
      {
        sessionId: SessionId('original'), status: 'active',
        record: { ...every, scheduledAt: '2026-09-16T00:05:00.000Z' },
        deliveryHistory: { earlierRecordsUnavailable: true, earlierRecordsPruned: false, records: [{
          scheduledAt: '2026-09-16T00:00:00.000Z', deliveredAt: '2026-09-16T00:00:00.000Z',
          messageId: message.id, prompt: 'Interval check',
        }] },
        lastDelivery: {
          scheduledAt: '2026-09-16T00:00:00.000Z', deliveredAt: '2026-09-16T00:00:00.000Z', messageId: message.id,
        },
      },
    ])
  })

  it.each(['after', 'at'] as const)('rearms a %s task when the clock rolls back during Session resolution', async (kind) => {
    const target = '2026-09-16T00:00:00.000Z'
    const record = kind === 'after'
      ? createAfterScheduleRecord(ScheduleId('rollback-once'), 'Wait for target', 1, Date.now() - 1000, 'Wait for target')
      : createAtScheduleRecord(ScheduleId('rollback-once'), 'Wait for target', target, Date.now() - 1000, 'Wait for target')
    const records = [task(record)]
    const test = await setup(records)
    const entered = Promise.withResolvers<undefined>()
    const resolved = Promise.withResolvers<{ agent: Agent }>()
    test.resolve.mockImplementationOnce(() => { entered.resolve(undefined); return resolved.promise })
    test.runtime.requestDrive()
    await entered.promise
    vi.setSystemTime(new Date('2026-09-15T23:59:59.000Z'))
    resolved.resolve({ agent: test.agent })
    await vi.advanceTimersByTimeAsync(0)
    expect(test.followup).not.toHaveBeenCalled()
    expect(test.flush).not.toHaveBeenCalled()
    expect(test.commit).not.toHaveBeenCalled()
    expect(records).toEqual([task(record)])
    await vi.advanceTimersByTimeAsync(999)
    expect(test.resolve).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(test.resolve).toHaveBeenCalledTimes(2)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(records[0]).toEqual({
      ...task(record), status: 'inactive',
      deliveryHistory: { earlierRecordsUnavailable: true, earlierRecordsPruned: false, records: [{
        scheduledAt: target, deliveredAt: target, messageId: test.followup.mock.calls[0]![0].id, prompt: 'Wait for target',
      }] },
      lastDelivery: { scheduledAt: target, deliveredAt: target, messageId: test.followup.mock.calls[0]![0].id },
    })
  })

  it('delivers only still-due members of a mixed batch and rearms its future member after clock rollback', async () => {
    const every = createEveryScheduleRecord(
      ScheduleId('rollback-every'), 'Future interval', 300, Date.now() - 300_000, 'Future interval',
    )
    const daily = createDailyScheduleRecord(ScheduleId('rollback-daily'), 'Due daily', {
      time: '07:59:30', time_zone: 'Asia/Shanghai',
    }, Date.parse('2026-09-15T23:59:00.000Z'), 'Due daily')
    const records = [task(every), task(daily)]
    const test = await setup(records)
    const entered = Promise.withResolvers<undefined>()
    const resolved = Promise.withResolvers<{ agent: Agent }>()
    test.resolve.mockImplementationOnce(() => { entered.resolve(undefined); return resolved.promise })
    test.runtime.requestDrive()
    await entered.promise
    vi.setSystemTime(new Date('2026-09-15T23:59:45.000Z'))
    resolved.resolve({ agent: test.agent })
    await vi.advanceTimersByTimeAsync(0)
    expect(test.resolve).toHaveBeenCalledTimes(1)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(test.commit).toHaveBeenCalledTimes(1)
    const dailyMessage = test.followup.mock.calls[0]![0]
    expect(JSON.stringify(dailyMessage.content)).toContain('Due daily')
    expect(JSON.stringify(dailyMessage.content)).not.toContain('Future interval')
    expect(records[0]).toEqual(task(every))
    expect(records[1]).toEqual({
      ...task(daily), record: { ...daily, scheduledAt: '2026-09-16T23:59:30.000Z' },
      deliveryHistory: { earlierRecordsUnavailable: true, earlierRecordsPruned: false, records: [{
        scheduledAt: '2026-09-15T23:59:30.000Z', deliveredAt: '2026-09-15T23:59:45.000Z',
        messageId: dailyMessage.id, prompt: 'Due daily',
      }] },
      lastDelivery: {
        scheduledAt: '2026-09-15T23:59:30.000Z', deliveredAt: '2026-09-15T23:59:45.000Z', messageId: dailyMessage.id,
      },
    })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(test.followup).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(test.followup).toHaveBeenCalledTimes(2)
    const everyMessage = test.followup.mock.calls[1]![0]
    expect(JSON.stringify(everyMessage.content)).toContain('Future interval')
    expect(JSON.stringify(everyMessage.content)).not.toContain('Due daily')
    expect(records[0]).toEqual({
      ...task(every), record: { ...every, scheduledAt: '2026-09-16T00:05:00.000Z' },
      deliveryHistory: { earlierRecordsUnavailable: true, earlierRecordsPruned: false, records: [{
        scheduledAt: '2026-09-16T00:00:00.000Z', deliveredAt: '2026-09-16T00:00:00.000Z',
        messageId: everyMessage.id, prompt: 'Future interval',
      }] },
      lastDelivery: {
        scheduledAt: '2026-09-16T00:00:00.000Z', deliveredAt: '2026-09-16T00:00:00.000Z', messageId: everyMessage.id,
      },
    })
  })

  it('rearms a mixed batch without enqueue or commit when every member becomes future during resolution', async () => {
    const daily = createDailyScheduleRecord(ScheduleId('future-daily'), 'Daily later', {
      time: '08:00:00', time_zone: 'Asia/Shanghai',
    }, Date.now() - 1000, 'Daily later')
    const every = createEveryScheduleRecord(
      ScheduleId('future-every'), 'Interval later', 300, Date.now() - 300_000, 'Interval later',
    )
    const records = [task(daily), task(every)]
    const test = await setup(records)
    const entered = Promise.withResolvers<undefined>()
    const resolved = Promise.withResolvers<{ agent: Agent }>()
    test.resolve.mockImplementationOnce(() => { entered.resolve(undefined); return resolved.promise })
    test.runtime.requestDrive()
    await entered.promise
    vi.setSystemTime(new Date('2026-09-15T23:59:59.000Z'))
    resolved.resolve({ agent: test.agent })
    await vi.advanceTimersByTimeAsync(0)
    expect(test.followup).not.toHaveBeenCalled()
    expect(test.flush).not.toHaveBeenCalled()
    expect(test.commit).not.toHaveBeenCalled()
    expect(records).toEqual([task(daily), task(every)])
    await vi.advanceTimersByTimeAsync(999)
    expect(test.resolve).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(test.resolve).toHaveBeenCalledTimes(2)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(test.commit).toHaveBeenCalledTimes(2)
    const message = test.followup.mock.calls[0]![0]
    expect(JSON.stringify(message.content)).toContain('Daily later')
    expect(JSON.stringify(message.content)).toContain('Interval later')
    expect(records.map(item => item.record.scheduledAt)).toEqual([
      '2026-09-17T00:00:00.000Z', '2026-09-16T00:05:00.000Z',
    ])
    expect(records.map(item => item.lastDelivery)).toEqual([0, 1].map(() => ({
      scheduledAt: '2026-09-16T00:00:00.000Z', deliveredAt: '2026-09-16T00:00:00.000Z', messageId: message.id,
    })))
  })

  it('keeps a task when the Session controller returns a declared resolution error', async () => {
    const records = [task(createAfterScheduleRecord(ScheduleId('missing'), 'Missing', 1, Date.now() - 2000, 'Missing'))]
    const test = await setup(records)
    test.resolve.mockResolvedValueOnce({ error: new Error('missing Session') } as never)
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.followup).not.toHaveBeenCalled()
    expect(test.commit).not.toHaveBeenCalled()
    expect(records).toHaveLength(1)
  })

  it('keeps an enqueued task when the Session reports no durability acknowledgment', async () => {
    const records = [task(createAfterScheduleRecord(ScheduleId('unacknowledged'), 'Keep', 1, Date.now() - 2000, 'Keep'))]
    const test = await setup(records)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValue(false)
    try {
      test.runtime.requestDrive()
      await vi.advanceTimersByTimeAsync(0)
      expect(test.followup).toHaveBeenCalledTimes(1)
      expect(test.commit).not.toHaveBeenCalled()
      expect(records).toHaveLength(1)
      expect(records[0]?.status).toBe('active')
      expect(records[0]?.lastDelivery).toBeUndefined()
    } finally {
      flush.mockRestore()
    }
  })

  it('retires a recurring task after the final representable occurrence', async () => {
    const records = [task(createEveryScheduleRecord(ScheduleId('last'), 'Last', 300,
      Date.parse('9999-12-31T23:49:59.999Z'), 'Last'))]
    const original = records[0]!
    vi.setSystemTime(new Date('9999-12-31T23:59:59.999Z'))
    const test = await setup(records)
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.commit).toHaveBeenCalledTimes(1)
    expect(records).toEqual([{
      ...original, status: 'inactive',
      record: { ...original.record, scheduledAt: '9999-12-31T23:59:59.999Z' },
      deliveryHistory: { earlierRecordsUnavailable: true, earlierRecordsPruned: false, records: [{
        scheduledAt: '9999-12-31T23:59:59.999Z', deliveredAt: '9999-12-31T23:59:59.999Z',
        messageId: test.followup.mock.calls[0]![0].id, prompt: 'Last',
      }] },
      lastDelivery: {
        scheduledAt: '9999-12-31T23:59:59.999Z', deliveredAt: '9999-12-31T23:59:59.999Z',
        messageId: test.followup.mock.calls[0]![0].id,
      },
    }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the final daily occurrence as the ended target without rearming', async () => {
    const record = createDailyScheduleRecord(ScheduleId('daily-last'), 'Last daily', {
      time: '23:59:59.999', time_zone: 'UTC',
    }, Date.parse('9999-12-29T00:00:00.000Z'), 'Last daily')
    const records = [task(record)]
    vi.setSystemTime(new Date('9999-12-31T23:59:59.999Z'))
    const test = await setup(records)
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(test.commit).toHaveBeenCalledTimes(1)
    expect(records).toEqual([{
      ...task(record), status: 'inactive',
      record: { ...record, scheduledAt: '9999-12-31T23:59:59.999Z' },
      deliveryHistory: { earlierRecordsUnavailable: true, earlierRecordsPruned: false, records: [{
        scheduledAt: '9999-12-31T23:59:59.999Z', deliveredAt: '9999-12-31T23:59:59.999Z',
        messageId: test.followup.mock.calls[0]![0].id, prompt: 'Last daily',
      }] },
      lastDelivery: {
        scheduledAt: '9999-12-31T23:59:59.999Z', deliveredAt: '9999-12-31T23:59:59.999Z',
        messageId: test.followup.mock.calls[0]![0].id,
      },
    }])
    expect(vi.getTimerCount()).toBe(0)
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(test.resolve).toHaveBeenCalledTimes(1)
  })

  it('coalesces management wakes while a delivery is waiting for Session resolution', async () => {
    const records = [task(createAfterScheduleRecord(ScheduleId('waiting'), 'Wait', 1, Date.now() - 2000, 'Wait'))]
    const test = await setup(records)
    const resolved = Promise.withResolvers<{ agent: Agent }>()
    test.resolve.mockReturnValueOnce(resolved.promise)
    test.runtime.requestDrive()
    test.runtime.requestDrive()
    test.runtime.requestDrive()
    resolved.resolve({ agent: test.agent })
    await vi.advanceTimersByTimeAsync(0)
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(records).toHaveLength(1)
    expect(records[0]?.status).toBe('inactive')
    await test.runtime.dispose()
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.followup).toHaveBeenCalledTimes(1)
  })

  describe.each(['every', 'daily'] as const)('%s timer ownership', (kind) => {
    it.each(['resolution', 'flush'] as const)('keeps one timer after wakes during %s and none after disposal', async (stage) => {
      const record = kind === 'every'
        ? createEveryScheduleRecord(ScheduleId('recurring-wake'), 'Repeat', 300, Date.now() - 300_000, 'Repeat')
        : createDailyScheduleRecord(
          ScheduleId('recurring-wake'), 'Repeat', { time: '00:00:00', time_zone: 'UTC' },
          Date.parse('2026-09-15T00:00:00Z'), 'Repeat',
        )
      const records = [task(record)]
      const test = await setup(records)
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      if (stage === 'resolution') {
        test.resolve.mockImplementationOnce(async () => {
          entered.resolve(undefined)
          await release.promise
          return { agent: test.agent }
        })
      } else {
        test.flush.mockImplementationOnce(async () => {
          entered.resolve(undefined)
          await release.promise
        })
      }
      try {
        test.runtime.requestDrive()
        await entered.promise
        test.runtime.requestDrive()
        test.runtime.requestDrive()
        release.resolve(undefined)
        await vi.advanceTimersByTimeAsync(0)
        expect(test.followup).toHaveBeenCalledTimes(1)
        expect(test.commit).toHaveBeenCalledTimes(1)
        expect(records[0]?.status).toBe('active')
        expect(vi.getTimerCount()).toBe(1)
      } finally {
        release.resolve(undefined)
        await test.runtime.dispose()
      }
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(86_400_000)
      expect(test.followup).toHaveBeenCalledTimes(1)
    })
  })

  it.each([1, 2])('stops between committed tasks without arming a new timer (%i due tasks)', async (count) => {
    const records = Array.from({ length: count }, (_, index) =>
      task(createAfterScheduleRecord(ScheduleId(`stop-${index}`), 'Stop', 1, Date.now() - 2000, 'Stop')))
    const test = await setup(records)
    let stopped: Promise<void> | undefined
    test.commit.mockImplementationOnce(async (ended) => {
      records[0] = ended
      stopped = test.runtime.dispose()
    })
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    await stopped
    expect(test.resolve).toHaveBeenCalledTimes(1)
    expect(test.commit).toHaveBeenCalledTimes(1)
    expect(records).toHaveLength(count)
    expect(records.filter(record => record.status === 'active')).toHaveLength(count - 1)
    expect(records[0]?.status).toBe('inactive')
  })

  it('logs a rejected serialization operation and honors a wake requested before retirement', async () => {
    const test = await setup([])
    const failed = Promise.withResolvers<undefined>()
    const transaction = vi.fn<(work: () => Promise<void>) => Promise<void>>()
      .mockReturnValueOnce(failed.promise)
      .mockImplementation(work => work())
    const runtime = new ScheduleRuntime(test.ctx, () => [], transaction, async () => {}, { days: 30, records: 200 })
    runtimes.push(runtime)
    const warning = vi.spyOn(test.ctx.logger, 'warn').mockImplementationOnce(() => { runtime.requestDrive() })
    runtime.requestDrive()
    failed.reject(new Error('serialization unavailable'))
    await vi.advanceTimersByTimeAsync(0)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('serialization unavailable'))
    expect(transaction).toHaveBeenCalledTimes(2)
  })

  it('contains recomputation admission refusal between ancestor unloading and runtime cleanup', async () => {
    const test = await setup([])
    await vi.advanceTimersByTimeAsync(0)
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    const records = [task(createEveryScheduleRecord(ScheduleId('retiring'), 'Future occurrence', 300, Date.now(), 'Future occurrence'))]
    const transaction = vi.fn(async (work: () => Promise<void>) => {
      await work()
      entered.resolve(undefined)
      await released.promise
    })
    const runtime = new ScheduleRuntime(test.ctx, () => records, transaction, async () => {}, { days: 30, records: 200 })
    runtimes.push(runtime)
    test.ctx.effect(() => () => runtime.dispose())
    const stop = vi.spyOn(runtime, 'dispose')
    const admission = vi.spyOn(test.ctx.agents, 'withoutInitiator')
    const warning = vi.spyOn(test.ctx.logger, 'warn')
    let unloading: Promise<void> | undefined
    try {
      runtime.requestDrive()
      const result = admission.mock.results[0]
      if (result?.type !== 'return') throw new Error('Drive was not admitted')
      // The loop has retired; its catch has queued finally before this observer queues cleanup.
      const retired = (result.value as Promise<void>).then(() => {
        runtime.requestDrive()
        unloading = test.ctx.fiber.dispose()
        expect(stop).not.toHaveBeenCalled()
      })
      await entered.promise
      expect(vi.getTimerCount()).toBe(1)
      released.resolve(undefined)
      await retired
      await unloading
      await vi.advanceTimersByTimeAsync(0)
      expect(admission).toHaveBeenCalledTimes(2)
      expect(admission.mock.results[1]).toMatchObject({ type: 'throw' })
      expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('agent initiator scope is disposed'))
      expect(transaction).toHaveBeenCalledTimes(1)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(86_400_000)
      expect(admission).toHaveBeenCalledTimes(2)
      expect(transaction).toHaveBeenCalledTimes(1)
    } finally {
      released.resolve(undefined)
      await unloading
      stop.mockRestore()
      admission.mockRestore()
      warning.mockRestore()
    }
  })

  it('drains a rejected serialization promise during disposal', async () => {
    const test = await setup([])
    const transaction = Promise.withResolvers<undefined>()
    const runtime = new ScheduleRuntime(test.ctx, () => [], () => transaction.promise, async () => {}, { days: 30, records: 200 })
    runtimes.push(runtime)
    runtime.requestDrive()
    const stopped = runtime.dispose()
    transaction.reject(new Error('domain closed'))
    await stopped
    expect(test.resolve).not.toHaveBeenCalled()
  })
})
