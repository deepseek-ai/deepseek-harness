/** Native fixture cleanup remains active after assertion failure and without a started client. */
import { afterAll, describe, expect } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createClientTest, webApp, type TestClient } from '../src/assembly/index.ts'

const test = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })
const clients: TestClient[] = []
const expired: (() => Promise<TestClient>)[] = []

afterAll(async () => {
  expect(clients).toHaveLength(2)
  for (const client of clients) {
    expect(client.ctx.get('loader')).toBeUndefined()
    expect(client.mock.log.streams('$events').map(stream => stream.state)).toEqual(['cancelled'])
  }
  for (const start of expired) {
    await expect(start()).rejects.toThrow('after its test fixture closed')
  }
  expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
})

describe('createClientTest', () => {
  test('allows response configuration before boot and shares concurrent starts', async ({ mock, remote, start }) => {
    expired.push(start)
    expect(remote).toBe(mock.remote)
    remote.session.rename.mockResolvedValueOnce(ok({ title: 'test title', seq: 1 }))
    const first = start()
    const second = start()
    expect(second).toBe(first)
    const client = await first
    clients.push(client)
    expect(client.mock).toBe(mock)
    expect(mock.log.streams('$events')).toHaveLength(1)
    await expect(client.ctx.remote.session.rename({ sessionId: 's' as SessionId, title: 't' }))
      .resolves.toEqual(ok({ title: 'test title', seq: 1 }))
    expect(remote.session.rename).toHaveBeenCalledExactlyOnceWith({ sessionId: 's', title: 't' })
  })

  test.fails('disposes its client even when the test assertion fails', async ({ start }) => {
    expired.push(start)
    clients.push(await start())
    expect.fail('fixture cleanup negative control')
  })

  test('does not boot an unused start fixture', ({ mock, start }) => {
    expired.push(start)
    expect(mock.log.streams()).toEqual([])
    expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
  })

  test('owns a fresh mock when only the mock fixture is requested', ({ mock }) => {
    expect(mock.log.calls()).toEqual([])
    expect(mock.log.streams()).toEqual([])
    expect(mock.endpoints()).not.toContain('session/rename')
  })
})

const missingConnection = createClientTest({ roster: webApp.pick(['@deepseek-ai/dsh-typert-registry']) })
missingConnection('keeps a rejected startup with its caller and releases its globals', async ({ start }) => {
  expired.push(start)
  await expect(start()).rejects.toThrow('provides no `connection` service')
  expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
})
