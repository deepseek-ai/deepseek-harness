import { describe, expect, it } from 'vitest'
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol'
import {
  parseRemoteEventResult,
  parseRemoteStreamClientMessage,
  projectRemoteEventRequest,
  projectRemoteEventRejection,
  restoreRemoteEventRejection,
} from '../src/stream-protocol.ts'

describe('Remote Event result protocol', () => {
  it('accepts delegation, values, and structured rejections', () => {
    expect(parseRemoteEventResult({
      clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'next' },
    })).toEqual({ clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'next' } })
    expect(parseRemoteEventResult({
      clientId: 'client-1', eventId: 'event-2', outcome: { kind: 'result' },
    })).toEqual({ clientId: 'client-1', eventId: 'event-2', outcome: { kind: 'result' } })
    expect(parseRemoteEventResult({
      clientId: 'client-1', eventId: 'event-3', outcome: { kind: 'result', value: { accepted: true } },
    })).toEqual({
      clientId: 'client-1', eventId: 'event-3', outcome: { kind: 'result', value: { accepted: true } },
    })
    expect(parseRemoteEventResult({
      clientId: 'client-1',
      eventId: 'event-minimal',
      outcome: { kind: 'rejected', error: { name: 'Error', message: 'offline' } },
    })).toEqual({
      clientId: 'client-1',
      eventId: 'event-minimal',
      outcome: { kind: 'rejected', error: { name: 'Error', message: 'offline' } },
    })
    expect(parseRemoteEventResult({
      clientId: 'client-1',
      eventId: 'event-4',
      outcome: {
        kind: 'rejected',
        error: {
          name: 'ApprovalError',
          message: 'declined',
          code: 'DECLINED',
          details: { retryable: false },
        },
      },
    })).toEqual({
      clientId: 'client-1',
      eventId: 'event-4',
      outcome: {
        kind: 'rejected',
        error: {
          name: 'ApprovalError',
          message: 'declined',
          code: 'DECLINED',
          details: { retryable: false },
        },
      },
    })
  })

  it.each([
    null,
    [],
    {},
    { clientId: '', eventId: 'event-1', outcome: { kind: 'next' } },
    { clientId: 'client-1', eventId: '', outcome: { kind: 'next' } },
    { clientId: 'client-1', eventId: 'event-1', outcome: null },
    { clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'next' }, extra: true },
    { clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'next', value: null } },
    { clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'result', extra: true } },
    { clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'result', value: undefined } },
    { clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'unknown' } },
    { clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'rejected', error: null } },
    { clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'rejected', error: { name: '', message: 'bad' } } },
    { clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'rejected', error: { name: 'Error', message: 1 } } },
    {
      clientId: 'client-1',
      eventId: 'event-1',
      outcome: { kind: 'rejected', error: { name: 'Error', message: 'bad', code: 1 } },
    },
    {
      clientId: 'client-1',
      eventId: 'event-1',
      outcome: { kind: 'rejected', error: { name: 'Error', message: 'bad', details: 1n } },
    },
    {
      clientId: 'client-1',
      eventId: 'event-1',
      outcome: { kind: 'rejected', error: { name: 'Error', message: 'bad', extra: true } },
    },
  ])('rejects an invalid result frame: %#', (value) => {
    expect(() => parseRemoteEventResult(value)).toThrow('api gateway: invalid Remote event')
  })

  it('rejects symbol properties in rejection records', () => {
    const error = { name: 'Error', message: 'bad', [Symbol('hidden')]: true }
    expect(() => parseRemoteEventResult({
      clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'rejected', error },
    })).toThrow('api gateway: invalid Remote event rejection')
  })
})

describe('Remote Event request projection', () => {
  it('removes only the direct Agent and signal fields', () => {
    const agent = { kind: 'agent' }
    const abort = new AbortController()
    const nested = { agent, signal: 'payload' }
    const projected = projectRemoteEventRequest({
      agent,
      signal: abort.signal,
      prompt: 'approve?',
      nested,
    }, agent)

    expect(projected).toEqual({
      request: { prompt: 'approve?', nested },
      signal: abort.signal,
    })
    expect(Object.getPrototypeOf(projected.request)).toBeNull()
  })

  it('accepts a null-prototype request and an omitted signal', () => {
    const agent = { kind: 'agent' }
    const request = Object.assign(Object.create(null) as Record<string, unknown>, {
      agent,
      accepted: true,
    })
    expect(projectRemoteEventRequest(request, agent)).toEqual({
      request: { accepted: true },
    })
  })

  it('requires the scoped Agent as a direct own field', () => {
    const agent = { kind: 'agent' }
    expect(() => projectRemoteEventRequest(null, agent))
      .toThrow('must carry its scoped Agent directly')
    expect(() => projectRemoteEventRequest({}, agent))
      .toThrow('must carry its scoped Agent directly')
    expect(() => projectRemoteEventRequest({ agent: {} }, agent))
      .toThrow('must carry its scoped Agent directly')
    expect(() => projectRemoteEventRequest(Object.create({ agent }), agent))
      .toThrow('must carry its scoped Agent directly')
  })

  it('rejects an invalid direct signal', () => {
    const agent = { kind: 'agent' }
    expect(() => projectRemoteEventRequest({ agent, signal: 'abort' }, agent))
      .toThrow('request signal must be an AbortSignal')
  })

  it('rejects non-JSON payload fields', () => {
    const agent = { kind: 'agent' }
    expect(() => projectRemoteEventRequest({ agent, value: 1n }, agent))
      .toThrow('request is not lossless JSON data')

    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => projectRemoteEventRequest({ agent, cycle }, agent))
      .toThrow('request is not lossless JSON data')
  })

  it('rejects symbol and non-enumerable payload fields', () => {
    const agent = { kind: 'agent' }
    expect(() => projectRemoteEventRequest({ agent, [Symbol('hidden')]: true }, agent))
      .toThrow('request has a non-JSON property')

    const hidden = { agent }
    Object.defineProperty(hidden, 'value', { value: true })
    expect(() => projectRemoteEventRequest(hidden, agent))
      .toThrow('request has a non-JSON property')
  })
})

describe('Remote Event rejection projection', () => {
  it('preserves stable error fields in both directions', () => {
    const reason = Object.assign(new Error('declined'), {
      name: 'ApprovalError',
      code: 'DECLINED',
      details: { retryable: false },
    })
    expect(projectRemoteEventRejection(reason)).toEqual({
      name: 'ApprovalError',
      message: 'declined',
      code: 'DECLINED',
      details: { retryable: false },
    })

    const restored = restoreRemoteEventRejection({
      name: 'ApprovalError',
      message: 'declined',
      code: 'DECLINED',
      details: { retryable: false },
    }) as Error & { code?: string; details?: unknown }
    expect(restored).toMatchObject({
      name: 'ApprovalError',
      message: 'declined',
      code: 'DECLINED',
      details: { retryable: false },
    })
  })

  it('normalizes arbitrary reasons and omits non-JSON optional fields', () => {
    expect(projectRemoteEventRejection('offline')).toEqual({
      name: 'Error', message: 'offline',
    })
    expect(projectRemoteEventRejection(undefined)).toEqual({
      name: 'Error', message: 'undefined',
    })
    expect(projectRemoteEventRejection({
      name: 1, message: 2, code: 3, details: 1n,
    })).toEqual({
      name: 'Error', message: '[object Object]',
    })

    const restored = restoreRemoteEventRejection({ name: 'Error', message: 'offline' })
    expect(restored).toMatchObject({ name: 'Error', message: 'offline' })
    expect(restored).not.toHaveProperty('code')
    expect(restored).not.toHaveProperty('details')
  })
})

describe('Remote Event JSON values', () => {
  it('accepts lossless JSON values, null-prototype objects, and repeated references', () => {
    const shared = { value: 1 }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      enabled: true,
    })
    expect(isRemoteJsonValue({
      null: null,
      string: 'value',
      boolean: true,
      number: 1.5,
      array: [shared, shared],
      nullPrototype,
    })).toBe(true)
  })

  it.each([
    undefined,
    1n,
    Symbol('value'),
    () => undefined,
    NaN,
    Number.POSITIVE_INFINITY,
    -0,
  ])('rejects a non-lossless scalar: %s', (value) => {
    expect(isRemoteJsonValue(value)).toBe(false)
  })

  it('rejects cycles and non-plain arrays and objects', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(isRemoteJsonValue(cycle)).toBe(false)

    class Fixture {
      value = 1
    }
    expect(isRemoteJsonValue(new Fixture())).toBe(false)

    const customArray = [1]
    Object.setPrototypeOf(customArray, null)
    expect(isRemoteJsonValue(customArray)).toBe(false)
    expect(isRemoteJsonValue(Object.assign([1], { extra: true }))).toBe(false)

    const sparse = new Array<unknown>(2)
    sparse[1] = 'value'
    expect(isRemoteJsonValue(sparse)).toBe(false)
    const disguisedSparse = Object.assign(new Array<unknown>(2), { extra: true })
    disguisedSparse[1] = 'value'
    expect(isRemoteJsonValue(disguisedSparse)).toBe(false)
    expect(isRemoteJsonValue([undefined])).toBe(false)

    const symbolic = { [Symbol('value')]: true }
    expect(isRemoteJsonValue(symbolic)).toBe(false)
    const hidden = {}
    Object.defineProperty(hidden, 'value', { value: true })
    expect(isRemoteJsonValue(hidden)).toBe(false)
    expect(isRemoteJsonValue({ nested: undefined })).toBe(false)
  })
})

describe('Remote stream client protocol', () => {
  it('rejects the removed logical-stream input message', () => {
    expect(() => parseRemoteStreamClientMessage(JSON.stringify({
      type: 'input', streamId: 'stream-1', value: { answer: true },
    }))).toThrow('api gateway: invalid Remote stream client message')
  })
})
