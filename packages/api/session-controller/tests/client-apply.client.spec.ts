/**
 * Session Controller Client apply inside the assembled client: Remote events
 * arriving as emit frames on the `$events` stream, the control stream over
 * the real Connection, and Agent Context identity through the Typert registry.
 */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, vi, type MockInstance } from 'vitest'
import { ClientSessions } from '../src/client/sessions/service.ts'
import type { SessionListValue } from '../src/types.ts'

const SELF = '@deepseek-ai/dsh-api-session-controller'
const ROSTER = webApp.closure([SELF])
const it = createClientTest({ roster: ROSTER })
const EVENTS = '$events'
const CONTROL = 'session/control'
const BASELINE = { type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } }
/** The first client boot pays the cold module transform of the cone. */
const COLD_BOOT_TIMEOUT_MS = 60_000

const sid = (value: string): SessionId => value as SessionId

afterEach(() => {
  vi.restoreAllMocks()
})

async function bench(start: () => Promise<TestClient>) {
  const client = await start()
  return { client, sessions: client.ctx.sessions as ClientSessions }
}

/** Deliver one Remote event the way the Host forwards it: an emit frame on the `$events` stream, consumed by the client. */
async function emit(mock: RemoteMock, event: string, ...args: unknown[]): Promise<void> {
  mock.streams.push(EVENTS, { type: 'emit', event, args })
  await mock.streams.drained(EVENTS)
}

function baselines(accept: MockInstance): number {
  return accept.mock.calls.filter(([frame]) => (frame as { type: string }).type === 'baseline').length
}

describe('Session Controller Client apply', () => {
  it('routes Remote events from the $events stream into the object layer and runs handleConnected once per generation', async ({ mock, start }) => {
    const connected = vi.spyOn(ClientSessions.prototype, 'handleConnected')
    const error = vi.spyOn(ClientSessions.prototype, 'handleSessionError')
    const { client, sessions } = await bench(start)
    // The first generation's `connection/reset` already ran it; apply itself saw no Host yet.
    await vi.waitFor(() => { expect(connected).toHaveBeenCalledOnce() })

    await emit(mock, 'api-session/added', { sessionId: sid('session-1'), updatedAt: 1, running: false, blank: true })
    await vi.waitFor(() => {
      expect(sessions.list.getSnapshot().byId[sid('session-1')]).toMatchObject({ running: false, updatedAt: 1 })
    })

    await emit(mock, 'api-session/status', sid('session-1'), true)
    await emit(mock, 'api-session/activity', sid('session-1'), 9)
    await emit(mock, 'api-session/error', sid('session-1'), 'agent failed')
    await vi.waitFor(() => {
      expect(sessions.list.getSnapshot().byId[sid('session-1')]).toMatchObject({ running: true, updatedAt: 9 })
    })
    expect(error).toHaveBeenCalledWith(sid('session-1'), 'agent failed')

    await emit(mock, 'api-session/removed', sid('session-1'))
    await vi.waitFor(() => { expect(sessions.list.getSnapshot().byId[sid('session-1')]).toBeUndefined() })

    client.connection.reconnect()
    await mock.streams.opened(EVENTS, 2)
    await vi.waitFor(() => { expect(connected).toHaveBeenCalledTimes(2) })
  }, COLD_BOOT_TIMEOUT_MS)

  it('runs handleConnected at apply when the Host is already connected, as a reload of the row does', async ({ start }) => {
    const connected = vi.spyOn(ClientSessions.prototype, 'handleConnected')
    const { client } = await bench(start)
    await vi.waitFor(() => { expect(connected).toHaveBeenCalledOnce() })
    await client.reload(SELF)
    expect(connected).toHaveBeenCalledTimes(2)
  })

  it('accepts the control baseline, retries a carrier loss once, and reports a second opening snapshot as a protocol failure', async ({ mock, start }) => {
    const accept = vi.spyOn(ClientSessions.prototype, 'handleControlFrame')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await start()
    await vi.waitFor(() => { expect(baselines(accept)).toBe(1) })
    expect(accept).toHaveBeenCalledWith(BASELINE)

    // One immediate retry while the Host is available reopens the stream, whose script pushes the baseline again.
    mock.streams.fail(CONTROL, new RemoteStreamCarrierError('generation lost'))
    await vi.waitFor(() => { expect(baselines(accept)).toBe(2) })
    expect(mock.log.streams(CONTROL)).toHaveLength(2)

    mock.streams.push(CONTROL, BASELINE)
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(
        '[session-controller] control stream failed:',
        expect.objectContaining({ message: 'session control stream emitted more than one opening snapshot' }),
      )
    })
  })

  it('materializes Host-addressed Agent scopes before the Session list arrives', async ({ mock, start }) => {
    const list = Promise.withResolvers<RemoteResult<SessionListValue>>()
    mock.remote.session.list.mockReturnValueOnce(list.promise)
    const { client, sessions } = await bench(start)
    const adapter = client.ctx.typert.contexts.getClient('agent')
    const first = adapter?.resolve(sid('agent-early'))

    expect(first).toBeDefined()
    expect(sessions.scopeOf(first as Context)).toBe(sid('agent-early'))
    expect(adapter?.resolve(sid('agent-early'))).toBe(first)
    list.resolve(ok({ items: [] }))
    await vi.waitFor(() => { expect(sessions.list.getSnapshot().phase).toBe('ready') })
  })

  it('projects Agent Context identity in both directions and withdraws the adapter when the row unloads', async ({ mock, start }) => {
    const { client, sessions } = await bench(start)
    await vi.waitFor(() => { expect(sessions.list.getSnapshot().phase).toBe('ready') })

    await emit(mock, 'api-session/added', { sessionId: sid('agent-1'), updatedAt: 1, running: false, blank: true })
    await vi.waitFor(() => { expect(sessions.scope(sid('agent-1'))).toBeDefined() })
    const scoped = sessions.scope(sid('agent-1')) as Context
    const adapter = client.ctx.typert.contexts.getClient('agent')
    expect(adapter?.identity(client.ctx)).toBeUndefined()
    expect(adapter?.identity(scoped)).toBe(sid('agent-1'))
    expect(adapter?.resolve(sid('agent-1'))).toBe(scoped)

    await client.unload(SELF)
    expect(client.ctx.typert.contexts.getClient('agent')).toBeUndefined()
  })

  it('waits for a Host generation before retrying the control stream', async ({ mock, start }) => {
    const accept = vi.spyOn(ClientSessions.prototype, 'handleControlFrame')
    const hostBack = Promise.withResolvers<undefined>()
    let opens = 0
    // The second $events generation stays unready until the test lets the Host answer.
    mock.stream(EVENTS, (_args, stream) => {
      opens += 1
      const ready = { type: 'ready', clientId: `mock-client-${String(opens)}`, host: { home: '/home/mock' } }
      if (opens === 1) stream.push(ready)
      else void hostBack.promise.then(() => { stream.push(ready) })
    })
    const client = await start()
    await vi.waitFor(() => { expect(baselines(accept)).toBe(1) })

    client.connection.reconnect()
    await mock.streams.opened(EVENTS, 2)
    expect(client.connection.generation.getSnapshot()).toBeUndefined()

    mock.streams.fail(CONTROL, new RemoteStreamCarrierError('offline'))
    await client.flush()
    expect(baselines(accept)).toBe(1)
    expect(mock.log.streams(CONTROL)).toHaveLength(1)

    hostBack.resolve(undefined)
    await vi.waitFor(() => { expect(baselines(accept)).toBe(2) })
    expect(client.connection.generation.getSnapshot()).toMatchObject({ id: 2 })
  })
})
